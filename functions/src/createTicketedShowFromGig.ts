// createTicketedShowFromGig + listSelfTicketGigs — Phase B of the PRIS ↔
// Hollywood Groove ticketing integration (PRIS_TICKETING_VENUE_INTEGRATION_PLAN.md §B).
//
// A platform_admin in the HG ticketing portal picks a PRIS gig that was marked
// "We sell" (ticketing_mode = 'self') and sets up a ticket tier. This callable:
//   1. reads the gig from the PRIS Cloud CRM (same secret bridge as importPrisVenue),
//   2. creates/updates the Firestore ticketing `shows/{showId}` + one GA `ticketTypes` doc,
//   3. PATCHes the public ticket URL + show id + status back onto the PRIS gig,
//   4. returns the public ticket URL.
//
// The show id is deterministic (`pris_gig_<id>`) so re-running is idempotent —
// re-saving updates the same show rather than creating duplicates.

import crypto from "node:crypto";
import {
  DocumentReference,
  DocumentSnapshot,
  FieldValue,
  Timestamp,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import {
  getPrisApiBaseUrl,
  getPrisIntegrationSecret,
  getTicketingDb,
  PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET,
  REGION,
} from "./ticketing/config";
import { asRecord, nonEmptyString, normaliseEmail } from "./ticketing/shared";

// Public buyer-page base per selling front. The HG PWA serves the standalone
// event page behind each branded site's /tickets/event/:showId route.
const PUBLIC_TICKET_BASE: Record<string, string> = {
  hollywood_groove: "https://hollywoodgroove.com.au/tickets/event",
  adele_show: "https://adeleshow.com.au/tickets/event",
};

const MELBOURNE_UTC_OFFSET = "+10:00"; // MVP: AEST. DST refinement is a follow-up.

interface PrisGig {
  id: number;
  title: string | null;
  gigDate: string | null;
  startTime: string | null;
  sellingFrontId: string | null;
  workspaceName: string | null;
  venueName: string | null;
  venueCompanyId: number | null;
  ticketingMode: string | null;
  ticketingShowId: string | null;
  ticketTierName: string | null;
  ticketPrice: number | null;
  ticketQuantity: number | null;
  ticketBookingFee: number | null;
}

interface PrisVenue {
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
  peopleCount: number;
  updatedAt: string | null;
}

interface CreateActor {
  uid: string;
  email: string | null;
  type: "platform_admin" | "pris_server";
}

function positiveInt(value: unknown, field: string, { min = 0 } = {}): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new HttpsError(
      "invalid-argument",
      `${field} must be an integer >= ${min}.`,
    );
  }
  return n;
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : null;
}

function nonNegativeInteger(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 72)
    .replace(/-+$/g, "");
}

function buildPublicEventSlug(
  gig: PrisGig,
  title: string,
  showId: string,
): string {
  const titlePart = slugify(title);
  const datePart = slugify(gig.gigDate || "");
  const fallback = slugify(showId);
  return (
    [titlePart || fallback, datePart].filter(Boolean).join("-") || fallback
  );
}

async function resolvePublicEventSlug(
  db: ReturnType<typeof getTicketingDb>,
  baseSlug: string,
  showId: string,
): Promise<string> {
  const fallbackBase = baseSlug.slice(0, 56).replace(/-+$/g, "");
  const fallbackSlug = [fallbackBase, slugify(showId)]
    .filter(Boolean)
    .join("-");
  const candidates = Array.from(new Set([baseSlug, fallbackSlug]));
  for (const candidate of candidates) {
    const snap = await db.collection("eventSlugs").doc(candidate).get();
    if (!snap.exists || snap.data()?.showId === showId) {
      return candidate;
    }
  }
  return fallbackSlug;
}

function stringOrNull(value: unknown): string | null {
  return nonEmptyString(value) || null;
}

function getPrisSecretOrThrow(): string {
  const secret = getPrisIntegrationSecret();
  if (!secret) {
    throw new HttpsError(
      "failed-precondition",
      "PRIS integration secret is not configured.",
    );
  }
  return secret;
}

async function prisRequest(path: string, init?: RequestInit): Promise<unknown> {
  const secret = getPrisSecretOrThrow();
  const response = await fetch(`${getPrisApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-PRIS-Integration-Secret": secret,
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.warn("PRIS gig integration request failed", {
      status: response.status,
      path,
      body: body.slice(0, 400),
    });
    throw new HttpsError("unavailable", "PRIS integration request failed.");
  }
  return response.json();
}

function normalizeVenue(value: unknown): PrisVenue {
  const r = asRecord(value);
  const id = numberOrNull(r.id);
  const name = nonEmptyString(r.name);
  if (!id || !name) {
    throw new HttpsError("internal", "PRIS returned an invalid venue payload.");
  }

  const contact = asRecord(r.contact);
  return {
    id,
    name,
    companyType: stringOrNull(r.companyType),
    companyArea: stringOrNull(r.companyArea),
    workspaceId: numberOrNull(r.workspaceId),
    website: stringOrNull(r.website),
    domain: stringOrNull(r.domain),
    address: stringOrNull(r.address),
    capacity: numberOrNull(r.capacity),
    contact: {
      id:
        contact.id === undefined || contact.id === null
          ? null
          : String(contact.id),
      name: stringOrNull(contact.name),
      email: normaliseEmail(contact.email),
      phone: stringOrNull(contact.phone),
    },
    peopleCount:
      numberOrNull(r.peopleCount) ??
      (Array.isArray(r.people) ? r.people.length : 0),
    updatedAt: stringOrNull(r.updatedAt),
  };
}

function normalizeGig(value: unknown): PrisGig {
  const r = asRecord(value);
  const id = Number(r.id);
  if (!Number.isInteger(id) || id < 1) {
    throw new HttpsError("internal", "PRIS returned an invalid gig payload.");
  }
  return {
    id,
    title: nonEmptyString(r.title) || null,
    gigDate: nonEmptyString(r.gigDate) || null,
    startTime: nonEmptyString(r.startTime) || null,
    sellingFrontId: nonEmptyString(r.sellingFrontId) || null,
    workspaceName: nonEmptyString(r.workspaceName) || null,
    venueName: nonEmptyString(r.venueName) || null,
    venueCompanyId: r.venueCompanyId == null ? null : Number(r.venueCompanyId),
    ticketingMode: nonEmptyString(r.ticketingMode) || null,
    ticketingShowId: nonEmptyString(r.ticketingShowId) || null,
    ticketTierName: nonEmptyString(r.ticketTierName) || null,
    ticketPrice: r.ticketPrice == null ? null : Number(r.ticketPrice),
    ticketQuantity: r.ticketQuantity == null ? null : Number(r.ticketQuantity),
    ticketBookingFee:
      r.ticketBookingFee == null ? null : Number(r.ticketBookingFee),
  };
}

function showStartTimestamp(gig: PrisGig): Timestamp {
  if (!gig.gigDate) {
    throw new HttpsError(
      "failed-precondition",
      "The gig has no date set; add a date in PRIS first.",
    );
  }
  // Postgres `time` serialises as HH:MM:SS; normalise to HH:MM so the ISO is
  // valid (otherwise `${date}T14:00:00:00` has doubled seconds → unparseable).
  const rawTime = String(gig.startTime || "19:00").trim();
  const hhmm = /^\d{1,2}:\d{2}/.test(rawTime) ? rawTime.slice(0, 5) : "19:00";
  const iso = `${gig.gigDate}T${hhmm}:00${MELBOURNE_UTC_OFFSET}`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new HttpsError(
      "failed-precondition",
      "The gig has an unparseable date/time.",
    );
  }
  return Timestamp.fromDate(date);
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

function buildVenueProjection(
  venue: PrisVenue,
  actorUid: string,
  isCreate: boolean,
) {
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
    payload.public = true;
    payload.createdAt = FieldValue.serverTimestamp();
  }

  return payload;
}

async function ensureVenueForGig(
  gig: PrisGig,
  actorUid: string,
): Promise<string | null> {
  if (
    !gig.venueCompanyId ||
    !Number.isInteger(gig.venueCompanyId) ||
    gig.venueCompanyId < 1
  ) {
    return null;
  }

  try {
    const venue = normalizeVenue(
      await prisRequest(
        `/api/integrations/hollywood-groove/venues/${encodeURIComponent(String(gig.venueCompanyId))}`,
      ),
    );
    if ((venue.companyType || "").toLowerCase() !== "venue") {
      logger.warn("PRIS gig venue is not importable as a ticketing venue", {
        prisGigId: gig.id,
        prisCompanyId: gig.venueCompanyId,
        companyType: venue.companyType,
      });
      return null;
    }

    const { ref, snapshot } = await resolveVenueRef(venue.id);
    await ref.set(buildVenueProjection(venue, actorUid, !snapshot.exists), {
      merge: true,
    });
    return ref.id;
  } catch (error) {
    logger.warn("PRIS venue sync failed during ticketed show creation", {
      prisGigId: gig.id,
      prisCompanyId: gig.venueCompanyId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function secureCompareSecret(
  provided: string | null,
  expected: string | null,
): boolean {
  if (!provided || !expected) return false;
  const providedHash = crypto.createHash("sha256").update(provided).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

function extractIntegrationSecret(request: {
  get(name: string): string | undefined;
}): string | null {
  const headerSecret = nonEmptyString(request.get("X-PRIS-Integration-Secret"));
  if (headerSecret) return headerSecret;
  const authHeader = nonEmptyString(request.get("Authorization")) || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return bearerMatch ? bearerMatch[1].trim() : null;
}

function httpStatusForError(error: unknown): number {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  switch (code) {
    case "invalid-argument":
      return 400;
    case "unauthenticated":
      return 401;
    case "permission-denied":
      return 403;
    case "not-found":
      return 404;
    case "failed-precondition":
      return 412;
    case "unavailable":
      return 502;
    default:
      return 500;
  }
}

interface CreateResult {
  ok: true;
  showId: string;
  ticketUrl: string;
  sellingFrontId: string;
  created: boolean;
}

async function createTicketedShowForPrisGig(
  prisGigId: number,
  actor: CreateActor,
): Promise<CreateResult> {
  // 1. Read the gig from PRIS.
  const gig = normalizeGig(
    await prisRequest(`/api/integrations/hollywood-groove/gigs/${prisGigId}`),
  );
  if (gig.ticketingMode !== "self") {
    throw new HttpsError(
      "failed-precondition",
      "This gig is not set to self-ticketing in PRIS.",
    );
  }
  const sellingFrontId = gig.sellingFrontId;
  if (!sellingFrontId || !PUBLIC_TICKET_BASE[sellingFrontId]) {
    throw new HttpsError(
      "failed-precondition",
      "The gig's band does not map to a known selling front.",
    );
  }

  // Ticket tier comes from the gig (captured in the PRIS booking form).
  if (
    gig.ticketPrice == null ||
    !Number.isFinite(gig.ticketPrice) ||
    gig.ticketPrice < 0
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Set a ticket price on the gig in PRIS first.",
    );
  }
  if (
    gig.ticketQuantity == null ||
    !Number.isInteger(gig.ticketQuantity) ||
    gig.ticketQuantity < 1
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Set tickets-available (>= 1) on the gig in PRIS first.",
    );
  }
  const tierName = gig.ticketTierName || "General Admission";
  const priceCents = Math.round(gig.ticketPrice * 100);
  const bookingFeeCents =
    gig.ticketBookingFee == null
      ? 0
      : Math.max(0, Math.round(gig.ticketBookingFee * 100));
  const quantity = gig.ticketQuantity;

  const startDate = showStartTimestamp(gig);
  const db = getTicketingDb();
  const showId = `pris_gig_${gig.id}`;
  const showRef = db.collection("shows").doc(showId);
  const existing = await showRef.get();
  const created = !existing.exists;
  const ttRef = showRef.collection("ticketTypes").doc("ga");
  const ttExisting = await ttRef.get();
  const existingTicketType = asRecord(ttExisting.data());
  const committedQuantity = ttExisting.exists
    ? nonNegativeInteger(existingTicketType.quantitySold) +
      nonNegativeInteger(existingTicketType.quantityReserved)
    : 0;
  const safeQuantity = Math.max(quantity, committedQuantity);
  // New ticket types default to this per-order cap. Admins can raise or lower it
  // per show in /admin/ticketing afterwards; that edit is preserved across PRIS
  // re-syncs because we only set maxPerOrder when first creating the ticket type
  // (below), never on update.
  const DEFAULT_MAX_PER_ORDER = 20;
  const newTicketTypeMaxPerOrder = Math.max(
    1,
    Math.min(DEFAULT_MAX_PER_ORDER, safeQuantity),
  );
  if (safeQuantity !== quantity) {
    logger.warn("Preserved committed ticket inventory above PRIS quantity", {
      showId,
      prisGigId: gig.id,
      requestedQuantity: quantity,
      committedQuantity,
      safeQuantity,
    });
  }
  const venueId = await ensureVenueForGig(gig, actor.uid);

  const title =
    gig.title ||
    (gig.venueName
      ? `${gig.workspaceName || "Live show"} at ${gig.venueName}`
      : "Live show");
  const existingShowData = asRecord(existing.data());
  const existingPublicSlug = nonEmptyString(existingShowData.publicSlug);
  const publicSlug =
    existingPublicSlug ||
    (await resolvePublicEventSlug(
      db,
      buildPublicEventSlug(gig, title, showId),
      showId,
    ));

  // 2a. Upsert the show.
  const showPayload: Record<string, unknown> = {
    title,
    sellingFrontId,
    startDate,
    status: "on_sale",
    capacity: safeQuantity,
    ticketingEnabled: true,
    currency: "AUD",
    publicSlug,
    venueName: gig.venueName || null,
    refundPolicy: { mode: "default", cutoffHours: 24, allowAfterScan: false },
    pris: {
      gigId: gig.id,
      venueCompanyId: gig.venueCompanyId,
      source: "pris-cloud-crm",
      lastSyncedByUid: actor.uid,
      lastSyncedBy: actor.type,
    },
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (venueId) showPayload.venueId = venueId;
  if (created) showPayload.createdAt = FieldValue.serverTimestamp();
  await showRef.set(showPayload, { merge: true });
  await db
    .collection("eventSlugs")
    .doc(publicSlug)
    .set(
      {
        slug: publicSlug,
        showId,
        sellingFrontId,
        title,
        active: true,
        startDate,
        updatedAt: FieldValue.serverTimestamp(),
        ...(existingPublicSlug
          ? {}
          : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );

  // 2b. Upsert the single GA ticket type. Preserve sold/reserved on re-run.
  const ttPayload: Record<string, unknown> = {
    name: tierName,
    priceCents,
    bookingFeeCents,
    currency: "AUD",
    quantityTotal: safeQuantity,
    saleStartAt: FieldValue.serverTimestamp(),
    saleEndAt: startDate,
    active: true,
    displayOrder: 1,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!ttExisting.exists) {
    ttPayload.quantitySold = 0;
    ttPayload.quantityReserved = 0;
    // Only set the per-order cap on creation so a later admin edit survives
    // PRIS re-syncs (mirrors how sold/reserved are preserved above).
    ttPayload.maxPerOrder = newTicketTypeMaxPerOrder;
    ttPayload.createdAt = FieldValue.serverTimestamp();
  }
  await ttRef.set(ttPayload, { merge: true });

  const ticketUrl = `${PUBLIC_TICKET_BASE[sellingFrontId]}/${publicSlug}`;

  // 3. Write the link back onto the PRIS gig.
  await prisRequest(
    `/api/integrations/hollywood-groove/gigs/${gig.id}/ticketing-link`,
    {
      method: "PATCH",
      body: JSON.stringify({
        ticketing_show_id: showId,
        ticket_url: ticketUrl,
        ticketing_status: "live",
      }),
    },
  );

  // 4. Audit.
  await db.collection("auditLog").add({
    action: "create_ticketed_show_from_gig",
    status: "success",
    showId,
    prisGigId: gig.id,
    sellingFrontId,
    venueId,
    created,
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorType: actor.type,
    at: FieldValue.serverTimestamp(),
  });

  logger.info("Created ticketed show from PRIS gig", {
    showId,
    prisGigId: gig.id,
    venueId,
    actorType: actor.type,
    created,
  });
  return { ok: true, showId, ticketUrl, sellingFrontId, created };
}

export const createTicketedShowFromGig = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
    secrets: [PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET],
  },
  async (request): Promise<CreateResult> => {
    const authRequest = requireAuth(request, "platform_admin", {
      keyPrefix: "createTicketedShowFromGig",
      maxCalls: 20,
      windowMs: 60 * 1000,
    });

    const input = asRecord(request.data);
    const prisGigId = positiveInt(input.prisGigId, "prisGigId", { min: 1 });

    return createTicketedShowForPrisGig(prisGigId, {
      uid: authRequest.auth.uid,
      email: authRequest.auth.token.email || null,
      type: "platform_admin",
    });
  },
);

export const createTicketedShowFromPrisGig = onRequest(
  {
    region: REGION,
    secrets: [PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET],
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response
        .set("Allow", "POST")
        .status(405)
        .json({ error: "method_not_allowed" });
      return;
    }

    const expectedSecret = getPrisIntegrationSecret();
    if (!expectedSecret) {
      logger.error("PRIS ticketing endpoint secret is not configured");
      response.status(503).json({ error: "integration_not_configured" });
      return;
    }

    if (
      !secureCompareSecret(extractIntegrationSecret(request), expectedSecret)
    ) {
      logger.warn("Rejected unauthenticated PRIS ticketing sync request");
      response.status(401).json({ error: "unauthenticated" });
      return;
    }

    try {
      const input = asRecord(request.body);
      const prisGigId = positiveInt(
        input.prisGigId ?? input.pris_gig_id ?? input.gigId ?? input.id,
        "prisGigId",
        { min: 1 },
      );
      const result = await createTicketedShowForPrisGig(prisGigId, {
        uid: "pris-server",
        email: null,
        type: "pris_server",
      });
      response.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Ticketing sync failed.";
      logger.warn("PRIS ticketing sync request failed", {
        status: httpStatusForError(error),
        message,
      });
      response.status(httpStatusForError(error)).json({
        error: "ticketing_sync_failed",
        message,
      });
    }
  },
);

interface SelfTicketGigRow {
  id: number;
  title: string | null;
  gigDate: string | null;
  venueName: string | null;
  sellingFrontId: string | null;
  ticketingShowId: string | null;
  ticketingStatus: string | null;
}

interface ListResult {
  gigs: SelfTicketGigRow[];
  count: number;
}

export const listSelfTicketGigs = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
    secrets: [PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET],
  },
  async (request): Promise<ListResult> => {
    requireAuth(request, "platform_admin", {
      keyPrefix: "listSelfTicketGigs",
      maxCalls: 30,
      windowMs: 60 * 1000,
    });

    const payload = asRecord(
      await prisRequest(`/api/integrations/hollywood-groove/gigs?limit=50`),
    );
    const rows = Array.isArray(payload.gigs) ? payload.gigs : [];
    const gigs: SelfTicketGigRow[] = rows
      .map((value) => {
        const r = asRecord(value);
        return {
          id: Number(r.id),
          title: nonEmptyString(r.title) || null,
          gigDate: nonEmptyString(r.gigDate) || null,
          venueName: nonEmptyString(r.venueName) || null,
          sellingFrontId: nonEmptyString(r.sellingFrontId) || null,
          ticketingShowId: nonEmptyString(r.ticketingShowId) || null,
          ticketingStatus: nonEmptyString(r.ticketingStatus) || null,
        };
      })
      .filter((g) => Number.isInteger(g.id));
    return { gigs, count: gigs.length };
  },
);
