import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { createHash } from "node:crypto";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import { getTicketingDb, REGION } from "./ticketing/config";

type TicketShareClaimData = {
  ticketId?: unknown;
  recipientEmail?: unknown;
  sharedByUid?: unknown;
  showId?: unknown;
  expiresAt?: unknown;
};

type TicketData = {
  status?: unknown;
};

type ClaimedTicket = {
  ticketId: string;
  showId: string | null;
};

function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export const claimMyPendingTickets = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
  },
  async (request) => {
    const authRequest = requireAuth(request, null, {
      keyPrefix: "claimMyPendingTickets",
      maxCalls: 6,
      windowMs: 60 * 1000,
    });

    const callerEmail = typeof authRequest.auth.token.email === "string"
      ? authRequest.auth.token.email.trim().toLowerCase()
      : null;
    const emailVerified = authRequest.auth.token.email_verified === true;
    if (!callerEmail || !emailVerified) {
      return { ok: true, claimed: [] as ClaimedTicket[] };
    }

    const uid = authRequest.auth.uid;
    const emailHash = hashEmail(callerEmail);
    const db = getTicketingDb();
    const matches = await db.collection("ticketShareClaims")
      .where("emailHash", "==", emailHash)
      .get();

    if (matches.empty) {
      return { ok: true, claimed: [] as ClaimedTicket[] };
    }

    const claimed: ClaimedTicket[] = [];
    const now = Date.now();

    for (const docSnap of matches.docs) {
      const claim = docSnap.data() as TicketShareClaimData;
      const ticketId = stringOrNull(claim.ticketId) ?? docSnap.id;
      const expiresAtTs = claim.expiresAt as Timestamp | null | undefined;
      if (expiresAtTs && expiresAtTs.toMillis() <= now) {
        await docSnap.ref.delete();
        continue;
      }

      const ticketRef = db.collection("tickets").doc(ticketId);
      const didClaim = await db.runTransaction(async (tx) => {
        const ticketSnap = await tx.get(ticketRef);
        if (!ticketSnap.exists) {
          tx.delete(docSnap.ref);
          return false;
        }

        const ticket = ticketSnap.data() as TicketData;
        if (ticket.status !== "valid") {
          tx.delete(docSnap.ref);
          return false;
        }

        tx.update(ticketRef, {
          holderMemberUid: uid,
          shareState: {
            status: "claimed",
            claimedByUid: uid,
            claimedAt: FieldValue.serverTimestamp(),
            sharedToEmail: stringOrNull(claim.recipientEmail) ?? callerEmail,
          },
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.delete(docSnap.ref);
        tx.set(db.collection("auditLog").doc(), {
          actorUid: uid,
          action: "ticket_claim",
          targetType: "ticket",
          targetId: ticketId,
          after: {
            claimedByUid: uid,
            fromSharedByUid: stringOrNull(claim.sharedByUid),
            showId: stringOrNull(claim.showId),
          },
          serverTimestamp: FieldValue.serverTimestamp(),
        });
        return true;
      });

      if (didClaim) {
        claimed.push({ ticketId, showId: stringOrNull(claim.showId) });
      }
    }

    return { ok: true, claimed };
  },
);
