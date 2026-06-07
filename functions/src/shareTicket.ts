import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { createHash } from "node:crypto";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import { sendEmail } from "./lib/email/emailService";
import { shareInviteEmail } from "./lib/email/templates";
import {
  getTicketClaimUrl,
  getTicketingDb,
  REGION,
  RESEND_API_KEY,
} from "./ticketing/config";
import {
  asRecord,
  generateQrToken,
  hashQrToken,
  nonEmptyString,
  normaliseEmail,
  timestampMillis,
} from "./ticketing/shared";

type ShareTicketInput = {
  ticketId: string;
  recipientEmail: string;
  recipientName?: string;
};

type TicketData = {
  status?: unknown;
  holderMemberUid?: unknown;
  holderName?: unknown;
  orderId?: unknown;
  showId?: unknown;
  sellingFrontId?: unknown;
  showTitle?: unknown;
  showStartDate?: unknown;
};

type OrderData = {
  buyerUid?: unknown;
};

function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function requireInputString(value: unknown, fieldName: string): string {
  const text = nonEmptyString(value);
  if (!text) {
    throw new HttpsError("invalid-argument", `${fieldName} is required.`);
  }
  return text;
}

function validateRecipientName(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const recipientName = nonEmptyString(value);
  if (!recipientName) {
    throw new HttpsError(
      "invalid-argument",
      "recipientName must be a non-empty string.",
    );
  }
  if (recipientName.length > 120) {
    throw new HttpsError(
      "invalid-argument",
      "recipientName must be 120 characters or fewer.",
    );
  }
  return recipientName;
}

function validateInput(data: unknown): ShareTicketInput {
  const record = asRecord(data);
  const recipientEmail = normaliseEmail(record.recipientEmail);
  if (!recipientEmail) {
    throw new HttpsError(
      "invalid-argument",
      "recipientEmail must be a valid email.",
    );
  }

  return {
    ticketId: requireInputString(record.ticketId, "ticketId"),
    recipientEmail,
    recipientName: validateRecipientName(record.recipientName),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function formatShowStartDateText(value: unknown): string | null {
  const millis = timestampMillis(value);
  if (millis <= 0) {
    return null;
  }
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Australia/Melbourne",
  }).format(new Date(millis));
}

export const shareTicket = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
    secrets: [RESEND_API_KEY],
  },
  async (request) => {
    const authRequest = requireAuth(request, null, {
      keyPrefix: "shareTicket",
      maxCalls: 30,
      windowMs: 60 * 1000,
      requireEmailVerified: true,
    });
    const input = validateInput(request.data);
    const callerUid = authRequest.auth.uid;
    const token = authRequest.auth.token;
    const callerEmail = typeof token.email === "string"
      ? token.email.toLowerCase()
      : null;
    const callerName = typeof token.name === "string" ? token.name : undefined;

    if (input.recipientEmail === callerEmail) {
      throw new HttpsError(
        "failed-precondition",
        "You already hold this ticket.",
      );
    }

    const db = getTicketingDb();
    const ticketRef = db.collection("tickets").doc(input.ticketId);
    const claimRef = db.collection("ticketShareClaims").doc(input.ticketId);
    let capturedShowTitle: string | null = null;
    let capturedShowStartDate: unknown = null;
    let capturedSellingFrontId: string | undefined;
    let capturedShowId: string | null = null;

    await db.runTransaction(async (tx) => {
      const ticketSnap = await tx.get(ticketRef);
      if (!ticketSnap.exists) {
        throw new HttpsError("not-found", "Ticket not found.");
      }

      const ticket = ticketSnap.data() as TicketData;
      if (ticket.status !== "valid") {
        throw new HttpsError(
          "failed-precondition",
          "Only valid tickets can be shared.",
        );
      }

      const orderId = stringOrNull(ticket.orderId);
      const showId = stringOrNull(ticket.showId);
      if (!orderId || !showId) {
        throw new HttpsError(
          "failed-precondition",
          "Ticket is missing required order or show details.",
        );
      }

      const isHolder = ticket.holderMemberUid === callerUid;
      let isBuyer = false;
      const orderSnap = await tx.get(db.collection("orders").doc(orderId));
      if (orderSnap.exists) {
        const order = orderSnap.data() as OrderData;
        isBuyer = order.buyerUid === callerUid;
      }
      if (!isHolder && !isBuyer) {
        throw new HttpsError(
          "permission-denied",
          "You can only share tickets you bought or hold.",
        );
      }

      const newToken = generateQrToken();
      const newHash = hashQrToken(newToken);
      const sellingFrontId = stringOrNull(ticket.sellingFrontId);
      const showTitle = stringOrNull(ticket.showTitle);
      const holderName = input.recipientName ?? stringOrNull(ticket.holderName);

      tx.update(ticketRef, {
        holderMemberUid: null,
        holderName,
        holderEmail: input.recipientEmail,
        holderConsentSource: "share",
        holderConsentAt: null,
        holderEmailOptIn: false,
        holderSmsOptIn: false,
        qrToken: newToken,
        qrTokenHash: newHash,
        shareState: {
          status: "pending",
          sharedToEmail: input.recipientEmail,
          sharedByUid: callerUid,
          sharedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(claimRef, {
        ticketId: input.ticketId,
        orderId,
        showId,
        sellingFrontId: sellingFrontId ?? null,
        showTitle: showTitle ?? null,
        showStartDate: ticket.showStartDate ?? null,
        emailHash: hashEmail(input.recipientEmail),
        recipientEmail: input.recipientEmail,
        recipientName: input.recipientName ?? null,
        sharedByUid: callerUid,
        sharedByEmail: callerEmail,
        status: "pending",
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      tx.set(db.collection("auditLog").doc(), {
        actorUid: callerUid,
        action: "ticket_share",
        targetType: "ticket",
        targetId: input.ticketId,
        before: { holderMemberUid: ticket.holderMemberUid ?? null },
        after: {
          sharedToEmail: input.recipientEmail,
          orderId,
          showId,
        },
        serverTimestamp: FieldValue.serverTimestamp(),
      });

      capturedShowTitle = showTitle;
      capturedShowStartDate = ticket.showStartDate ?? null;
      capturedSellingFrontId = sellingFrontId ?? undefined;
      capturedShowId = showId;
    });

    try {
      const template = shareInviteEmail({
        sellingFrontId: capturedSellingFrontId,
        sharerName: callerName ?? null,
        recipientName: input.recipientName ?? null,
        showTitle: capturedShowTitle ?? "your event",
        showStartDateText: formatShowStartDateText(capturedShowStartDate),
        claimUrl: getTicketClaimUrl(capturedShowId ?? undefined),
      });
      await sendEmail({
        to: input.recipientEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });
    } catch (error) {
      logger.warn("Ticket share invite email failed", {
        ticketId: input.ticketId,
        recipientEmail: input.recipientEmail,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      ok: true,
      ticketId: input.ticketId,
      sharedToEmail: input.recipientEmail,
    };
  },
);
