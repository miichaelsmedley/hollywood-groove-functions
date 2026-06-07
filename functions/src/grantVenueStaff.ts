// Per-venue staff role grants for ticketing.
//
// Roles are two-axis:
//   1. The Firebase custom claim (`door_staff` or `venue_manager`) marks the
//      user as "has been a staffer somewhere." It's set globally on the auth
//      record so the PWA can decide whether to render scanner UI at all.
//   2. The Firestore doc at `venues/{venueId}/eligibleStaff/{uid}` is the
//      venue-scoped grant. Only when BOTH exist will `validateTicketScan`
//      (Phase 4b) approve a scan at that venue.
//
// This split means revoking access at one venue never breaks access at
// another — and a hostile actor with a stale claim still can't scan because
// they're not listed at any active venue.
//
// Email-invite flow: if the admin grants by an email the system doesn't yet
// know, we write a pending invite at
// `venues/{venueId}/eligibleStaffInvites/{inviteId}` instead. The auth
// trigger in `resolveVenueStaffInvites.ts` redeems pending invites when the
// matching user signs in for the first time.

import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { ServerValue } from "firebase-admin/database";
import { logger } from "firebase-functions/v2";
import { HttpsError, CallableRequest, onCall } from "firebase-functions/v2/https";
import { createHash } from "node:crypto";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import {
  getPrisApiBaseUrl,
  getPrisIntegrationSecret,
  getTicketingDb,
  PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET,
  REGION,
} from "./ticketing/config";

type VenueStaffRole = "door_staff" | "venue_manager";
type TicketingUserRole =
  | "none"
  | "scanner"
  | "ticketer"
  | "ticket_admin"
  | "absolute_admin";

const VENUE_STAFF_ROLES = new Set<VenueStaffRole>(["door_staff", "venue_manager"]);

// Max forward-window for a temporary grant. Longer than this and you're better
// off granting open-ended and revoking when done.
const MAX_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

interface GrantInput {
  venueId: string;
  email?: string;
  targetUid?: string;
  role: VenueStaffRole;
  expiresAt?: number | null; // epoch ms
}

interface RevokeInput {
  venueId: string;
  targetUid?: string;
  email?: string; // revoke a pending invite by the email it was sent to
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEmail(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text) return null;
  const lower = text.toLowerCase();
  return lower.includes("@") ? lower : null;
}

function ticketingRoleFromClaims(claims: Record<string, unknown>): TicketingUserRole {
  if (claims.platform_admin === true) return "absolute_admin";
  if (claims.event_admin === true) return "ticket_admin";
  if (claims.venue_manager === true) return "ticketer";
  if (claims.door_staff === true) return "scanner";
  return "none";
}

async function syncPrisTicketingRole(params: {
  targetUid: string;
  email?: string | null;
  displayName?: string | null;
  ticketingRole: TicketingUserRole;
  actorUid?: string | null;
  actorEmail?: string | null;
  source: string;
}): Promise<string | null> {
  const email = normalizeEmail(params.email);
  if (!email) return "PRIS sync skipped (target email missing)";
  const secret = getPrisIntegrationSecret();
  if (!secret) return "PRIS sync skipped (not configured)";

  try {
    const response = await fetch(
      `${getPrisApiBaseUrl()}/api/integrations/hollywood-groove/ticketing-admins`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PRIS-Integration-Secret": secret,
        },
        body: JSON.stringify({
          email,
          displayName: params.displayName || null,
          firebaseUid: params.targetUid,
          ticketing_role: params.ticketingRole,
          actorUid: params.actorUid || null,
          actorEmail: params.actorEmail || null,
          source: params.source,
        }),
      },
    );
    if (!response.ok) {
      const raw = await response.text();
      logger.warn("PRIS venue staff role projection failed", {
        email,
        ticketingRole: params.ticketingRole,
        status: response.status,
        reason: raw.slice(0, 160),
      });
      return `PRIS sync failed (${response.status})`;
    }
    return "PRIS user record updated";
  } catch (error) {
    logger.warn("PRIS venue staff role projection request failed", {
      email,
      ticketingRole: params.ticketingRole,
      reason: error instanceof Error ? error.message : "unknown_error",
    });
    return "PRIS sync failed";
  }
}

function hashEmail(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function validateGrantInput(data: unknown): GrantInput {
  const rec = asRecord(data);
  const venueId = nonEmptyString(rec.venueId);
  if (!venueId) {
    throw new HttpsError("invalid-argument", "venueId is required.");
  }

  const role = typeof rec.role === "string" ? rec.role : "";
  if (!VENUE_STAFF_ROLES.has(role as VenueStaffRole)) {
    throw new HttpsError("invalid-argument", "role must be door_staff or venue_manager.");
  }

  const email = normalizeEmail(rec.email);
  const targetUid = nonEmptyString(rec.targetUid);
  if (!email && !targetUid) {
    throw new HttpsError("invalid-argument", "Provide either email or targetUid.");
  }

  let expiresAt: number | null = null;
  if (rec.expiresAt !== undefined && rec.expiresAt !== null) {
    const n = Number(rec.expiresAt);
    if (!Number.isFinite(n) || n <= Date.now()) {
      throw new HttpsError("invalid-argument", "expiresAt must be a future epoch in ms.");
    }
    if (n - Date.now() > MAX_EXPIRY_MS) {
      throw new HttpsError("invalid-argument", "expiresAt is too far in the future.");
    }
    expiresAt = Math.floor(n);
  }

  return {
    venueId,
    email: email ?? undefined,
    targetUid: targetUid ?? undefined,
    role: role as VenueStaffRole,
    expiresAt,
  };
}

function validateRevokeInput(data: unknown): RevokeInput {
  const rec = asRecord(data);
  const venueId = nonEmptyString(rec.venueId);
  if (!venueId) {
    throw new HttpsError("invalid-argument", "venueId is required.");
  }
  const targetUid = nonEmptyString(rec.targetUid);
  const email = normalizeEmail(rec.email);
  if (!targetUid && !email) {
    throw new HttpsError("invalid-argument", "Provide either targetUid or email.");
  }
  return {
    venueId,
    targetUid: targetUid ?? undefined,
    email: email ?? undefined,
  };
}

async function writeAuditLog(params: {
  request: CallableRequest<unknown>;
  action: "grantVenueStaff" | "revokeVenueStaff" | "inviteVenueStaff";
  status: "success" | "denied" | "failed";
  details: Record<string, unknown>;
  reason?: string;
}): Promise<void> {
  await admin.database().ref("audit_log").push({
    actorUid: params.request.auth?.uid ?? null,
    actorEmail: params.request.auth?.token.email ?? null,
    action: params.action,
    status: params.status,
    reason: params.reason ?? null,
    details: params.details,
    at: ServerValue.TIMESTAMP,
  });
}

function isPlatformAdmin(token: Record<string, unknown>): boolean {
  return token.platform_admin === true;
}

async function ensureCallerCanManageVenue(
  request: CallableRequest<unknown>,
  venueId: string,
  targetRole: VenueStaffRole
): Promise<void> {
  const token: Record<string, unknown> = request.auth?.token ?? {};

  // Platform admins can manage anyone at any venue at any role.
  if (isPlatformAdmin(token)) return;

  // Venue managers can manage door_staff at their own venue, but cannot grant
  // venue_manager (that's a platform_admin-only escalation).
  if (token.venue_manager === true && targetRole === "door_staff") {
    const callerUid = request.auth?.uid;
    if (!callerUid) {
      throw new HttpsError("permission-denied", "Authenticated uid required.");
    }
    const doc = await getTicketingDb()
      .collection("venues").doc(venueId)
      .collection("eligibleStaff").doc(callerUid)
      .get();
    if (doc.exists && doc.data()?.role === "venue_manager") {
      return;
    }
  }

  throw new HttpsError(
    "permission-denied",
    "Only platform admins or this venue's manager can grant staff here."
  );
}

async function setClaim(
  targetUid: string,
  role: VenueStaffRole,
  grant: boolean,
): Promise<admin.auth.UserRecord> {
  const user = await admin.auth().getUser(targetUid);
  const claims = { ...(user.customClaims ?? {}) };
  if (grant) {
    claims[role] = true;
  } else {
    // Don't reflexively strip the claim — they may still be staff at another
    // venue. revokeVenueStaff has its own logic to decide whether to strip.
  }
  await admin.auth().setCustomUserClaims(targetUid, claims);
  return user;
}

async function stripClaimIfOrphaned(targetUid: string, role: VenueStaffRole): Promise<void> {
  // If the user has no remaining eligibleStaff rows with this role, drop the
  // claim. Cheap query: collectionGroup across all venues.
  const remaining = await getTicketingDb()
    .collectionGroup("eligibleStaff")
    .where("uid", "==", targetUid)
    .where("role", "==", role)
    .limit(1)
    .get();
  if (remaining.empty) {
    const user = await admin.auth().getUser(targetUid);
    const claims = { ...(user.customClaims ?? {}) };
    if (claims[role]) {
      delete claims[role];
      await admin.auth().setCustomUserClaims(targetUid, claims);
    }
  }
}

async function lookupUserByEmail(email: string): Promise<admin.auth.UserRecord | null> {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (error) {
    if ((error as { code?: string }).code === "auth/user-not-found") {
      return null;
    }
    throw error;
  }
}

export const grantVenueStaff = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
    secrets: [PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET],
  },
  async (request) => {
    const partial = asRecord(request.data);
    try {
      requireAuth(request, null, {
        keyPrefix: "grantVenueStaff",
        maxCalls: 30,
        windowMs: 60 * 1000,
      });
    } catch (err) {
      await writeAuditLog({
        request,
        action: "grantVenueStaff",
        status: "denied",
        details: partial,
        reason: err instanceof HttpsError ? err.code : "auth_failed",
      });
      throw err;
    }

    const input = validateGrantInput(request.data);

    try {
      await ensureCallerCanManageVenue(request, input.venueId, input.role);
    } catch (err) {
      await writeAuditLog({
        request,
        action: "grantVenueStaff",
        status: "denied",
        details: { ...input },
        reason: err instanceof HttpsError ? err.code : "manage_denied",
      });
      throw err;
    }

    // Venue must exist before we can grant against it.
    const db = getTicketingDb();
    const venueRef = db.collection("venues").doc(input.venueId);
    const venueSnap = await venueRef.get();
    if (!venueSnap.exists) {
      await writeAuditLog({
        request,
        action: "grantVenueStaff",
        status: "failed",
        details: { ...input },
        reason: "venue_not_found",
      });
      throw new HttpsError("not-found", "Venue does not exist.");
    }

    // Resolve to a uid: either provided directly, or via email lookup.
    let targetUid = input.targetUid ?? null;
    let targetEmail = input.email ?? null;
    if (!targetUid && targetEmail) {
      const user = await lookupUserByEmail(targetEmail);
      if (user) {
        targetUid = user.uid;
      }
    }

    const grantedAt = FieldValue.serverTimestamp();
    const expiresAt = input.expiresAt ? Timestamp.fromMillis(input.expiresAt) : null;

    if (targetUid) {
      // Direct grant: claim + eligibleStaff doc, atomic via batch.
      const targetUser = await setClaim(targetUid, input.role, true);

      const staffRef = venueRef.collection("eligibleStaff").doc(targetUid);
      await staffRef.set({
        uid: targetUid,
        role: input.role,
        grantedBy: request.auth!.uid,
        grantedAt,
        expiresAt,
        invitedEmail: targetEmail ?? null,
      });

      // If admin granted by email but the user existed, also clear any stale
      // pending invite for this email at this venue (defensive cleanup).
      if (targetEmail) {
        const invites = await venueRef.collection("eligibleStaffInvites")
          .where("emailHash", "==", hashEmail(targetEmail))
          .get();
        await Promise.all(invites.docs.map((d) => d.ref.delete()));
      }

      await writeAuditLog({
        request,
        action: "grantVenueStaff",
        status: "success",
        details: { venueId: input.venueId, targetUid, role: input.role, expiresAt: input.expiresAt },
      });
      logger.info("Venue staff granted", {
        venueId: input.venueId,
        targetUid,
        role: input.role,
        expiresAt: input.expiresAt,
      });
      const prisNote = await syncPrisTicketingRole({
        targetUid,
        email: targetUser.email || targetEmail,
        displayName: targetUser.displayName || null,
        ticketingRole: ticketingRoleFromClaims({
          ...(targetUser.customClaims ?? {}),
          [input.role]: true,
        }),
        actorUid: request.auth?.uid || null,
        actorEmail: typeof request.auth?.token.email === "string"
          ? request.auth.token.email
          : null,
        source: "hollywood-groove-venue-staff",
      });
      return {
        ok: true,
        outcome: "granted" as const,
        targetUid,
        note: `claim takes effect after target's ID token refreshes${prisNote ? `; ${prisNote}` : ""}`,
      };
    }

    // No uid yet — write an invite that resolves when the matching email signs in.
    if (!targetEmail) {
      throw new HttpsError("invalid-argument", "Could not resolve target.");
    }
    const inviteRef = venueRef.collection("eligibleStaffInvites").doc();
    await inviteRef.set({
      email: targetEmail,
      emailHash: hashEmail(targetEmail),
      role: input.role,
      expiresAt,
      invitedByUid: request.auth!.uid,
      invitedAt: grantedAt,
    });

    await writeAuditLog({
      request,
      action: "inviteVenueStaff",
      status: "success",
      details: {
        venueId: input.venueId,
        inviteId: inviteRef.id,
        role: input.role,
        // email logged at info level only — auditLog stays at hashes for PII hygiene
        emailHash: hashEmail(targetEmail),
      },
    });
    logger.info("Venue staff invited by email", {
      venueId: input.venueId,
      inviteId: inviteRef.id,
      role: input.role,
    });
    return {
      ok: true,
      outcome: "invited" as const,
      inviteId: inviteRef.id,
      note: "invite resolves when the matching email signs in",
    };
  }
);

export const revokeVenueStaff = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
    secrets: [PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET],
  },
  async (request) => {
    const partial = asRecord(request.data);
    try {
      requireAuth(request, null, {
        keyPrefix: "revokeVenueStaff",
        maxCalls: 30,
        windowMs: 60 * 1000,
      });
    } catch (err) {
      await writeAuditLog({
        request,
        action: "revokeVenueStaff",
        status: "denied",
        details: partial,
        reason: err instanceof HttpsError ? err.code : "auth_failed",
      });
      throw err;
    }

    const input = validateRevokeInput(request.data);

    // For revoke we don't yet know the target's role; permission check uses
    // door_staff as the floor (anyone above can revoke anyone below). If the
    // caller is platform_admin we can short-circuit.
    const token = request.auth?.token ?? {};
    if (!isPlatformAdmin(token)) {
      try {
        await ensureCallerCanManageVenue(request, input.venueId, "door_staff");
      } catch (err) {
        await writeAuditLog({
          request,
          action: "revokeVenueStaff",
          status: "denied",
          details: { ...input },
          reason: err instanceof HttpsError ? err.code : "manage_denied",
        });
        throw err;
      }
    }

    const db = getTicketingDb();
    const venueRef = db.collection("venues").doc(input.venueId);

    if (input.targetUid) {
      const staffRef = venueRef.collection("eligibleStaff").doc(input.targetUid);
      const snap = await staffRef.get();
      if (!snap.exists) {
        await writeAuditLog({
          request,
          action: "revokeVenueStaff",
          status: "failed",
          details: { ...input },
          reason: "staff_not_found",
        });
        throw new HttpsError("not-found", "That user is not staff at this venue.");
      }
      const role = (snap.data()?.role as VenueStaffRole) ?? "door_staff";

      // venue_manager-of-this-venue trying to revoke a venue_manager isn't allowed.
      if (!isPlatformAdmin(token) && role === "venue_manager") {
        await writeAuditLog({
          request,
          action: "revokeVenueStaff",
          status: "denied",
          details: { ...input, role },
          reason: "cannot_revoke_venue_manager",
        });
        throw new HttpsError(
          "permission-denied",
          "Only platform admins can revoke a venue_manager."
        );
      }

      await staffRef.delete();
      await stripClaimIfOrphaned(input.targetUid, role);
      const targetUser = await admin.auth().getUser(input.targetUid);
      const prisNote = await syncPrisTicketingRole({
        targetUid: input.targetUid,
        email: targetUser.email || null,
        displayName: targetUser.displayName || null,
        ticketingRole: ticketingRoleFromClaims(targetUser.customClaims ?? {}),
        actorUid: request.auth?.uid || null,
        actorEmail: typeof request.auth?.token.email === "string"
          ? request.auth.token.email
          : null,
        source: "hollywood-groove-venue-staff",
      });

      await writeAuditLog({
        request,
        action: "revokeVenueStaff",
        status: "success",
        details: { venueId: input.venueId, targetUid: input.targetUid, role },
      });
      logger.info("Venue staff revoked", { venueId: input.venueId, targetUid: input.targetUid, role });
      return { ok: true, outcome: "revoked" as const, note: prisNote };
    }

    // Revoke a pending invite by the email it was sent to.
    if (input.email) {
      const invites = await venueRef.collection("eligibleStaffInvites")
        .where("emailHash", "==", hashEmail(input.email))
        .get();
      if (invites.empty) {
        await writeAuditLog({
          request,
          action: "revokeVenueStaff",
          status: "failed",
          details: { ...input },
          reason: "invite_not_found",
        });
        throw new HttpsError("not-found", "No pending invite for that email at this venue.");
      }
      await Promise.all(invites.docs.map((d) => d.ref.delete()));
      await writeAuditLog({
        request,
        action: "revokeVenueStaff",
        status: "success",
        details: { venueId: input.venueId, emailHash: hashEmail(input.email), invitesRemoved: invites.size },
      });
      return { ok: true, outcome: "invite_cancelled" as const, count: invites.size };
    }

    throw new HttpsError("invalid-argument", "Could not resolve target.");
  }
);
