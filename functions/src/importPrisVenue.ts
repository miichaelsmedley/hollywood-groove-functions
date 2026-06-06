import { DocumentReference, DocumentSnapshot, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import {
  getPrisApiBaseUrl,
  getPrisIntegrationSecret,
  getTicketingDb,
  PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET,
  REGION,
} from "./ticketing/config";
import { asRecord, nonEmptyString, normaliseEmail } from "./ticketing/shared";

type PrisVenuePerson = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  phone: string | null;
  location: string | null;
  updatedAt: string | null;
};

type PrisVenue = {
  id: number;
  name: string;
  companyType: string | null;
  companyArea: string | null;
  workspaceId: number | null;
  website: string | null;
  domain: string | null;
  address: string | null;
  capacity: number | null;
  contact: {
    id?: string | number | null;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  people: PrisVenuePerson[];
  peopleCount: number;
  updatedAt: string | null;
  source: string;
};

type SearchPrisVenuesResult = {
  venues: PrisVenue[];
  count: number;
};

type ImportPrisVenueResult = {
  ok: true;
  venueId: string;
  prisCompanyId: number;
  imported: boolean;
  name: string;
};

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : null;
}

function stringOrNull(value: unknown): string | null {
  return nonEmptyString(value) || null;
}

function normalizePerson(value: unknown): PrisVenuePerson {
  const record = asRecord(value);
  return {
    id: String(record.id || ""),
    name: nonEmptyString(record.name) || "Contact",
    email: normaliseEmail(record.email),
    role: stringOrNull(record.role),
    phone: stringOrNull(record.phone),
    location: stringOrNull(record.location),
    updatedAt: stringOrNull(record.updatedAt),
  };
}

function normalizePrisVenue(value: unknown): PrisVenue {
  const record = asRecord(value);
  const id = numberOrNull(record.id);
  const name = nonEmptyString(record.name);
  if (!id || !name) {
    throw new HttpsError("internal", "PRIS returned an invalid venue payload.");
  }

  const contact = asRecord(record.contact);
  const people = Array.isArray(record.people)
    ? record.people.map(normalizePerson).filter((person) => person.id)
    : [];

  return {
    id,
    name,
    companyType: stringOrNull(record.companyType),
    companyArea: stringOrNull(record.companyArea),
    workspaceId: numberOrNull(record.workspaceId),
    website: stringOrNull(record.website),
    domain: stringOrNull(record.domain),
    address: stringOrNull(record.address),
    capacity: numberOrNull(record.capacity),
    contact: {
      id: contact.id === undefined || contact.id === null ? null : String(contact.id),
      name: stringOrNull(contact.name),
      email: normaliseEmail(contact.email),
      phone: stringOrNull(contact.phone),
    },
    people,
    peopleCount: numberOrNull(record.peopleCount) ?? people.length,
    updatedAt: stringOrNull(record.updatedAt),
    source: stringOrNull(record.source) || "pris-cloud-crm",
  };
}

function validateCompanyId(value: unknown): number {
  const id = numberOrNull(value);
  if (!id || id < 1) {
    throw new HttpsError("invalid-argument", "prisCompanyId is required.");
  }
  return id;
}

function getPrisSecretOrThrow(): string {
  const secret = getPrisIntegrationSecret();
  if (!secret) {
    throw new HttpsError("failed-precondition", "PRIS integration secret is not configured.");
  }
  return secret;
}

async function fetchPrisJson(path: string): Promise<unknown> {
  const secret = getPrisSecretOrThrow();
  const url = `${getPrisApiBaseUrl()}${path}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "X-PRIS-Integration-Secret": secret,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.warn("PRIS integration request failed", {
      status: response.status,
      path,
      body: body.slice(0, 400),
    });
    throw new HttpsError("unavailable", "PRIS integration request failed.");
  }

  return response.json();
}

async function resolveVenueRef(prisCompanyId: number): Promise<{
  ref: DocumentReference;
  snapshot: DocumentSnapshot;
}> {
  const db = getTicketingDb();
  const canonicalRef = db.collection("venues").doc(`pris_${prisCompanyId}`);
  const canonicalSnapshot = await canonicalRef.get();
  if (canonicalSnapshot.exists) {
    return { ref: canonicalRef, snapshot: canonicalSnapshot };
  }

  const existingByPrisId = await db
    .collection("venues")
    .where("pris.companyId", "==", prisCompanyId)
    .limit(1)
    .get();
  if (!existingByPrisId.empty) {
    const existing = existingByPrisId.docs[0];
    return { ref: existing.ref, snapshot: existing };
  }

  return { ref: canonicalRef, snapshot: canonicalSnapshot };
}

function buildVenueProjection(venue: PrisVenue, actorUid: string, isCreate: boolean, createPublic: boolean) {
  const payload: Record<string, unknown> = {
    name: venue.name,
    address: venue.address || "",
    capacity: venue.capacity,
    contact: {
      name: venue.contact.name || "",
      email: venue.contact.email || "",
      phone: venue.contact.phone || "",
    },
    pris: {
      companyId: venue.id,
      source: "pris-cloud-crm",
      companyType: venue.companyType,
      companyArea: venue.companyArea,
      workspaceId: venue.workspaceId,
      companyUpdatedAt: venue.updatedAt,
      lastSyncedAt: FieldValue.serverTimestamp(),
      lastSyncedByUid: actorUid,
      syncStatus: "synced",
      peopleCount: venue.peopleCount,
      primaryContactId: venue.contact.id || null,
      website: venue.website,
      domain: venue.domain,
    },
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (isCreate) {
    payload.public = createPublic;
    payload.createdAt = FieldValue.serverTimestamp();
  }

  return payload;
}

export const searchPrisVenues = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
    secrets: [PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET],
  },
  async (request): Promise<SearchPrisVenuesResult> => {
    requireAuth(request, "platform_admin", {
      keyPrefix: "searchPrisVenues",
      maxCalls: 30,
      windowMs: 60 * 1000,
    });

    const input = asRecord(request.data);
    const search = nonEmptyString(input.search) || "";
    const type = nonEmptyString(input.type) || "venue";
    const limit = numberOrNull(input.limit) ?? 12;
    const params = new URLSearchParams({
      search,
      type,
      limit: String(Math.max(1, Math.min(25, limit))),
    });

    const payload = asRecord(await fetchPrisJson(`/api/integrations/hollywood-groove/venues?${params}`));
    const venues = Array.isArray(payload.venues)
      ? payload.venues.map(normalizePrisVenue)
      : [];
    return {
      venues,
      count: numberOrNull(payload.count) ?? venues.length,
    };
  }
);

export const importPrisVenue = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
    secrets: [PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET],
  },
  async (request): Promise<ImportPrisVenueResult> => {
    const authRequest = requireAuth(request, "platform_admin", {
      keyPrefix: "importPrisVenue",
      maxCalls: 15,
      windowMs: 60 * 1000,
    });

    const input = asRecord(request.data);
    const prisCompanyId = validateCompanyId(input.prisCompanyId);
    const venue = normalizePrisVenue(
      await fetchPrisJson(`/api/integrations/hollywood-groove/venues/${encodeURIComponent(String(prisCompanyId))}`)
    );

    if ((venue.companyType || "").toLowerCase() !== "venue") {
      throw new HttpsError("failed-precondition", "Only PRIS venue records can be imported as ticketing venues.");
    }

    const { ref, snapshot } = await resolveVenueRef(prisCompanyId);
    const isCreate = !snapshot.exists;
    const createPublic = input.public === false ? false : true;
    await ref.set(
      buildVenueProjection(venue, authRequest.auth.uid, isCreate, createPublic),
      { merge: true }
    );

    await getTicketingDb().collection("auditLog").add({
      action: "pris_venue_import",
      status: "success",
      venueId: ref.id,
      prisCompanyId,
      imported: isCreate,
      actorUid: authRequest.auth.uid,
      actorEmail: authRequest.auth.token.email || null,
      at: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      venueId: ref.id,
      prisCompanyId,
      imported: isCreate,
      name: venue.name,
    };
  }
);
