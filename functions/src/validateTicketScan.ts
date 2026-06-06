// validateTicketScan — the door-scanner callable (Phase 4b).
//
// A door staffer opens the PWA scanner, picks the show they're working, and
// scans ticket QR codes. The QR encodes the ticket's raw `qrToken`; this
// function hashes it, finds the matching ticket, runs every safety check,
// and atomically marks a valid ticket `used` so it can't be reused.
//
// Two-axis permission (same model as grantVenueStaff): the caller must hold
// a `door_staff` / `venue_manager` / `platform_admin` claim AND — unless
// platform_admin — be listed in `venues/{venueId}/eligibleStaff/{uid}` for
// the show's venue, with an unexpired grant.
//
// Idempotency: a re-scan of a ticket this same staffer marked `used` within
// the last 5 seconds returns `valid` again (network double-taps, jittery
// cameras) rather than a scary `already_used`.
//
// NOT in this function yet (deliberate, follow-up): writing the RTDB live
// attendee record and awarding loyalty stars. The engagement-side attendee
// schema and star accumulation aren't built; wiring a malformed record in
// here would risk the live trivia system. Scan validation + mark-used +
// scanEvents log is the Phase 4b scope.

import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { ServerValue } from "firebase-admin/database";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { createHash } from "node:crypto";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import { getTicketingDb, REGION } from "./ticketing/config";

type ScanResult =
  | "valid"
  | "already_used"
  | "wrong_event"
  | "refunded"
  | "cancelled"
  | "disputed"
  | "not_found";

const DUPLICATE_WINDOW_MS = 5000;

function hashQrToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface ScanInput {
  qrToken: string;
  showId: string;
  deviceInfo: string | null;
}

function validateInput(data: unknown): ScanInput {
  const rec = asRecord(data);
  const qrToken = nonEmptyString(rec.qrToken);
  const showId = nonEmptyString(rec.showId);
  if (!qrToken) {
    throw new HttpsError("invalid-argument", "qrToken is required.");
  }
  if (!showId) {
    throw new HttpsError("invalid-argument", "showId is required.");
  }
  return {
    qrToken,
    showId,
    deviceInfo: nonEmptyString(rec.deviceInfo),
  };
}

function callerHasAnyScanRole(token: Record<string, unknown>): boolean {
  return (
    token.platform_admin === true ||
    token.venue_manager === true ||
    token.door_staff === true
  );
}

async function callerCanScanVenue(
  token: Record<string, unknown>,
  callerUid: string,
  venueId: string
): Promise<boolean> {
  if (token.platform_admin === true) return true;
  const staffSnap = await getTicketingDb()
    .collection("venues").doc(venueId)
    .collection("eligibleStaff").doc(callerUid)
    .get();
  if (!staffSnap.exists) return false;
  const staff = staffSnap.data() ?? {};
  const role = staff.role;
  if (role !== "door_staff" && role !== "venue_manager") return false;
  const expiresAt = staff.expiresAt as Timestamp | null | undefined;
  if (expiresAt && expiresAt.toMillis() <= Date.now()) return false;
  return true;
}

async function writeAuditLog(params: {
  callerUid: string;
  callerEmail: string | null;
  showId: string;
  ticketId: string | null;
  result: ScanResult;
}): Promise<void> {
  await admin.database().ref("audit_log").push({
    actorUid: params.callerUid,
    actorEmail: params.callerEmail,
    action: "validateTicketScan",
    status: params.result === "valid" ? "success" : "rejected",
    details: {
      showId: params.showId,
      ticketId: params.ticketId,
      result: params.result,
    },
    at: ServerValue.TIMESTAMP,
  });
}

interface ScanResponse {
  result: ScanResult;
  ticketId: string | null;
  holderName: string | null;
  ticketTypeId: string | null;
  scannedAt: number;
  note: string;
}

export const validateTicketScan = onCall(
  { region: REGION, enforceAppCheck: REQUIRE_APP_CHECK },
  async (request): Promise<ScanResponse> => {
    const authRequest = requireAuth(request, null, {
      keyPrefix: "validateTicketScan",
      maxCalls: 90, // scanning a queue at the door — generous
      windowMs: 60 * 1000,
    });

    const token: Record<string, unknown> = authRequest.auth.token;
    const callerUid = authRequest.auth.uid;
    const callerEmail =
      typeof token.email === "string" ? token.email : null;

    if (!callerHasAnyScanRole(token)) {
      throw new HttpsError(
        "permission-denied",
        "You don't have ticket-scanning access."
      );
    }

    const input = validateInput(request.data);
    const db = getTicketingDb();
    const now = Date.now();

    // ----- locate the ticket by hashed QR token --------------------------
    const hash = hashQrToken(input.qrToken);
    const matches = await db
      .collection("tickets")
      .where("qrTokenHash", "==", hash)
      .limit(1)
      .get();

    if (matches.empty) {
      await writeAuditLog({
        callerUid,
        callerEmail,
        showId: input.showId,
        ticketId: null,
        result: "not_found",
      });
      return {
        result: "not_found",
        ticketId: null,
        holderName: null,
        ticketTypeId: null,
        scannedAt: now,
        note: "No ticket matches this QR code.",
      };
    }

    const ticketRef = matches.docs[0].ref;
    const ticket = matches.docs[0].data();
    const ticketId = ticketRef.id;
    const ticketShowId = String(ticket.showId ?? "");
    const holderName = nonEmptyString(ticket.holderName);
    const ticketTypeId = nonEmptyString(ticket.ticketTypeId);

    // ----- verify the staffer may scan at this show's venue --------------
    // The show is loaded from the TICKET's showId (the source of truth),
    // and we permission-check against that venue.
    const showSnap = await db.collection("shows").doc(ticketShowId).get();
    if (!showSnap.exists) {
      // Ticket references a show that no longer exists — treat as not_found
      // rather than leaking a half-state.
      await writeAuditLog({ callerUid, callerEmail, showId: input.showId, ticketId, result: "not_found" });
      return {
        result: "not_found",
        ticketId,
        holderName,
        ticketTypeId,
        scannedAt: now,
        note: "This ticket's show could not be found.",
      };
    }
    const venueId = String(showSnap.data()?.venueId ?? "");
    const canScan = await callerCanScanVenue(token, callerUid, venueId);
    if (!canScan) {
      throw new HttpsError(
        "permission-denied",
        "You're not assigned as door staff for this venue."
      );
    }

    const recordScanEvent = (result: ScanResult) => {
      return ticketRef.collection("scanEvents").add({
        scannedAt: FieldValue.serverTimestamp(),
        scannedByUid: callerUid,
        result,
        deviceInfo: input.deviceInfo,
        idempotencyKey: `${ticketId}:${callerUid}:${Math.floor(now / DUPLICATE_WINDOW_MS)}`,
      });
    };

    const respond = async (
      result: ScanResult,
      note: string
    ): Promise<ScanResponse> => {
      await recordScanEvent(result);
      await writeAuditLog({ callerUid, callerEmail, showId: input.showId, ticketId, result });
      return { result, ticketId, holderName, ticketTypeId, scannedAt: now, note };
    };

    // ----- the customer is at the wrong event ----------------------------
    if (ticketShowId !== input.showId) {
      return respond(
        "wrong_event",
        "This ticket is for a different show."
      );
    }

    // ----- non-valid ticket states ---------------------------------------
    const status = String(ticket.status ?? "");
    if (status === "refunded") {
      return respond("refunded", "This ticket was refunded.");
    }
    if (status === "cancelled") {
      return respond("cancelled", "This ticket was cancelled.");
    }
    if (status === "disputed" || status === "lost_to_dispute") {
      return respond("disputed", "This ticket is frozen due to a payment dispute.");
    }
    if (status === "used") {
      // Idempotent re-scan: same staffer, within the 5s window → still valid.
      const usedAt = ticket.usedAt as Timestamp | null | undefined;
      const usedBy = nonEmptyString(ticket.usedByStaffUid);
      const withinWindow =
        usedAt instanceof Timestamp && now - usedAt.toMillis() <= DUPLICATE_WINDOW_MS;
      if (usedBy === callerUid && withinWindow) {
        return respond("valid", "Already scanned by you — let them in.");
      }
      return respond("already_used", "This ticket has already been used.");
    }
    if (status !== "valid") {
      // Unknown / unexpected status — fail safe.
      return respond("already_used", `Ticket status is "${status}".`);
    }

    // ----- valid: atomically flip to used --------------------------------
    let outcome: ScanResult = "valid";
    let note = "Welcome — let them in.";
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ticketRef);
      const freshStatus = String(fresh.data()?.status ?? "");
      if (freshStatus === "used") {
        // Lost a race to a concurrent scan. Re-apply the idempotency rule.
        const usedAt = fresh.data()?.usedAt as Timestamp | null | undefined;
        const usedBy = nonEmptyString(fresh.data()?.usedByStaffUid);
        const withinWindow =
          usedAt instanceof Timestamp && now - usedAt.toMillis() <= DUPLICATE_WINDOW_MS;
        if (usedBy === callerUid && withinWindow) {
          outcome = "valid";
          note = "Already scanned by you — let them in.";
        } else {
          outcome = "already_used";
          note = "This ticket has already been used.";
        }
        return;
      }
      if (freshStatus !== "valid") {
        outcome = "already_used";
        note = `Ticket status is "${freshStatus}".`;
        return;
      }
      tx.update(ticketRef, {
        status: "used",
        usedAt: FieldValue.serverTimestamp(),
        usedByStaffUid: callerUid,
      });
    });

    logger.info("Ticket scan processed", {
      ticketId,
      showId: input.showId,
      result: outcome,
      scannedByUid: callerUid,
    });
    return respond(outcome, note);
  }
);
