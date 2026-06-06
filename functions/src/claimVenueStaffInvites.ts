// `claimMyPendingVenueStaffInvites` — called by the PWA after the user signs
// in (or upgrades from anonymous → Google). Looks up any pending invites
// matching the caller's email and redeems them atomically.
//
// We avoid Firebase Auth `onCreate` triggers because (a) they need v1/v2
// coexistence, and (b) they only fire at first sign-up, missing the common
// case where someone was already a member when the admin invited them.
//
// The caller's email is taken from the Firebase Auth token, not from input —
// so a bad actor can't claim invites that weren't sent to them.

import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { ServerValue } from "firebase-admin/database";
import { logger } from "firebase-functions/v2";
import { onCall } from "firebase-functions/v2/https";
import { createHash } from "node:crypto";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import { getTicketingDb, REGION } from "./ticketing/config";

type VenueStaffRole = "door_staff" | "venue_manager";

function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

interface RedeemedInvite {
  venueId: string;
  inviteId: string;
  role: VenueStaffRole;
}

export const claimMyPendingVenueStaffInvites = onCall(
  { region: REGION, enforceAppCheck: REQUIRE_APP_CHECK },
  async (request) => {
    const authRequest = requireAuth(request, null, {
      keyPrefix: "claimMyPendingVenueStaffInvites",
      maxCalls: 6, // PWA calls on every sign-in; 6/min is more than enough
      windowMs: 60 * 1000,
    });

    const callerEmail = typeof authRequest.auth.token.email === "string"
      ? authRequest.auth.token.email.trim().toLowerCase()
      : null;

    // No verified email = no claim. Anonymous-only users can't redeem invites
    // because invites are keyed to email — they must upgrade to Google or
    // similar first.
    const emailVerified = authRequest.auth.token.email_verified === true;
    if (!callerEmail || !emailVerified) {
      return { ok: true, redeemed: [] as RedeemedInvite[], note: "no verified email on this session" };
    }

    const targetUid = authRequest.auth.uid;
    const emailHash = hashEmail(callerEmail);
    const db = getTicketingDb();

    const matches = await db.collectionGroup("eligibleStaffInvites")
      .where("emailHash", "==", emailHash)
      .get();

    if (matches.empty) {
      return { ok: true, redeemed: [] as RedeemedInvite[] };
    }

    // Build the set of roles to attach to the claim object in a single update.
    const claimsToAdd = new Set<VenueStaffRole>();
    const redeemed: RedeemedInvite[] = [];

    // Fan out writes per match. Each match: write eligibleStaff doc + delete
    // invite. The claim update is collapsed to a single setCustomUserClaims at
    // the end so we don't thrash the auth record.
    const now = Date.now();
    for (const docSnap of matches.docs) {
      const data = docSnap.data();
      const role = data.role as VenueStaffRole;
      if (role !== "door_staff" && role !== "venue_manager") {
        // Defensive — shouldn't happen because grant validates role, but skip
        // any malformed invites rather than fail the whole batch.
        logger.warn("Skipping invite with unexpected role", { inviteId: docSnap.id, role });
        continue;
      }
      const expiresAtTs = data.expiresAt as Timestamp | null | undefined;
      if (expiresAtTs && expiresAtTs.toMillis() <= now) {
        // Expired before redemption — just delete the invite, don't grant.
        await docSnap.ref.delete();
        continue;
      }

      const venueId = docSnap.ref.parent.parent?.id;
      if (!venueId) {
        logger.warn("Invite missing parent venue", { inviteId: docSnap.id });
        continue;
      }

      const venueRef = db.collection("venues").doc(venueId);
      const staffRef = venueRef.collection("eligibleStaff").doc(targetUid);

      await db.runTransaction(async (tx) => {
        tx.set(staffRef, {
          uid: targetUid,
          role,
          grantedBy: data.invitedByUid ?? null,
          grantedAt: FieldValue.serverTimestamp(),
          expiresAt: expiresAtTs ?? null,
          invitedEmail: data.email ?? null,
          redeemedAt: FieldValue.serverTimestamp(),
        });
        tx.delete(docSnap.ref);
      });

      claimsToAdd.add(role);
      redeemed.push({ venueId, inviteId: docSnap.id, role });
    }

    if (claimsToAdd.size > 0) {
      const user = await admin.auth().getUser(targetUid);
      const next = { ...(user.customClaims ?? {}) };
      claimsToAdd.forEach((r) => {
        next[r] = true;
      });
      await admin.auth().setCustomUserClaims(targetUid, next);
    }

    if (redeemed.length > 0) {
      await admin.database().ref("audit_log").push({
        actorUid: targetUid,
        actorEmail: callerEmail,
        action: "claimVenueStaffInvites",
        status: "success",
        details: { redeemed },
        at: ServerValue.TIMESTAMP,
      });
    }

    logger.info("Venue staff invites redeemed", {
      uid: targetUid,
      count: redeemed.length,
      rolesAdded: Array.from(claimsToAdd),
    });

    return {
      ok: true,
      redeemed,
      note: redeemed.length > 0
        ? "claim takes effect after the next ID token refresh"
        : "no pending invites for this email",
    };
  }
);
