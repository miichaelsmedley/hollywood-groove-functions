import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAuth, UserRecord } from "firebase-admin/auth";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import { getTicketingDb, REGION } from "./ticketing/config";
import {
  asRecord,
  buildIssuedTicketData,
  nonEmptyString,
  normaliseEmail,
  TicketedShowData,
  TicketHolderInput,
  TicketTypeData,
} from "./ticketing/shared";

type IssueCompTicketInput = {
  showId: string;
  ticketTypeId: string;
  recipientName: string;
  recipientEmail: string;
  quantity: number;
  note: string | null;
  idempotencyKey: string;
};

type IssueCompTicketResult = {
  ok: true;
  orderId: string;
  ticketIds: string[];
  recipientUid: string;
  recipientEmail: string;
  showId: string;
  ticketTypeId: string;
  quantity: number;
  idempotent: boolean;
  note: string;
};

type ExistingIdempotencyRecord = {
  payloadHash?: string;
  orderId?: string;
  ticketIds?: string[];
  recipientUid?: string;
  recipientEmail?: string;
  showId?: string;
  ticketTypeId?: string;
  quantity?: number;
};

const MAX_COMP_QUANTITY = 20;
const ISSUABLE_SHOW_STATUSES = new Set(["published", "on_sale", "sold_out"]);

function requireString(value: unknown, fieldName: string): string {
  const text = nonEmptyString(value);
  if (!text) {
    throw new HttpsError("invalid-argument", `${fieldName} is required.`);
  }
  return text;
}

function validateQuantity(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return 1;
  }
  const quantity = Number(value);
  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_COMP_QUANTITY
  ) {
    throw new HttpsError(
      "invalid-argument",
      `quantity must be an integer between 1 and ${MAX_COMP_QUANTITY}.`,
    );
  }
  return quantity;
}

function validateIdempotencyKey(value: unknown): string {
  const key = nonEmptyString(value);
  if (!key || key.length < 8 || key.length > 160) {
    throw new HttpsError(
      "invalid-argument",
      "idempotencyKey must be between 8 and 160 characters.",
    );
  }
  return key;
}

function normalizeInput(data: unknown): IssueCompTicketInput {
  const record = asRecord(data);
  const recipientEmail = normaliseEmail(record.recipientEmail);
  if (!recipientEmail) {
    throw new HttpsError(
      "invalid-argument",
      "recipientEmail must be a valid email.",
    );
  }

  const note = nonEmptyString(record.note);
  if (note && note.length > 1000) {
    throw new HttpsError(
      "invalid-argument",
      "note must be 1000 characters or fewer.",
    );
  }

  return {
    showId: requireString(record.showId, "showId"),
    ticketTypeId: requireString(record.ticketTypeId, "ticketTypeId"),
    recipientName: requireString(record.recipientName, "recipientName"),
    recipientEmail,
    quantity: validateQuantity(record.quantity),
    note,
    idempotencyKey: validateIdempotencyKey(record.idempotencyKey),
  };
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashJson(value: Record<string, unknown>): string {
  return hashText(JSON.stringify(value));
}

async function resolveRecipient(email: string): Promise<UserRecord> {
  try {
    return await getAuth().getUserByEmail(email);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "auth/user-not-found") {
      throw new HttpsError(
        "failed-precondition",
        "Recipient must sign in to Hollywood Groove with this email before a comp ticket can be issued.",
      );
    }
    logger.error("Could not resolve comp ticket recipient by email", {
      email,
      error,
    });
    throw new HttpsError("internal", "Could not verify recipient account.");
  }
}

function validateCompIssuable(
  show: TicketedShowData,
  ticketType: TicketTypeData,
  quantity: number,
): void {
  if (!show.ticketingEnabled || !ISSUABLE_SHOW_STATUSES.has(show.status)) {
    throw new HttpsError(
      "failed-precondition",
      "Comp tickets can only be issued for published, on-sale, or sold-out ticketed shows.",
    );
  }
  if (!ticketType.active) {
    throw new HttpsError(
      "failed-precondition",
      "This ticket type is not active.",
    );
  }
  if (ticketType.currency !== show.currency || ticketType.currency !== "AUD") {
    throw new HttpsError(
      "failed-precondition",
      "Ticket currency is not supported.",
    );
  }

  const available =
    Number(ticketType.quantityTotal ?? 0) -
    Number(ticketType.quantitySold ?? 0) -
    Number(ticketType.quantityReserved ?? 0);
  if (available < quantity) {
    throw new HttpsError(
      "failed-precondition",
      "Not enough tickets are available.",
    );
  }
}

function buildHolders(input: IssueCompTicketInput): TicketHolderInput[] {
  return Array.from({ length: input.quantity }, (_, index) => ({
    holderName:
      index === 0
        ? input.recipientName
        : `${input.recipientName} guest ${index + 1}`,
    holderEmail: input.recipientEmail,
    holderPhone: null,
    holderEmailOptIn: false,
    holderSmsOptIn: false,
  }));
}

function existingResult(
  record: ExistingIdempotencyRecord,
): IssueCompTicketResult {
  const quantity = Number(record.quantity);
  if (
    !record.orderId ||
    !Array.isArray(record.ticketIds) ||
    !record.recipientUid ||
    !record.recipientEmail ||
    !record.showId ||
    !record.ticketTypeId ||
    !Number.isInteger(quantity)
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Idempotency record is incomplete.",
    );
  }

  return {
    ok: true,
    orderId: record.orderId,
    ticketIds: record.ticketIds,
    recipientUid: record.recipientUid,
    recipientEmail: record.recipientEmail,
    showId: record.showId,
    ticketTypeId: record.ticketTypeId,
    quantity,
    idempotent: true,
    note: "Comp ticket was already issued for this idempotency key.",
  };
}

export async function issueCompTicketAsAdmin(params: {
  actorUid: string;
  data: unknown;
}): Promise<IssueCompTicketResult> {
  const input = normalizeInput(params.data);
  const recipient = await resolveRecipient(input.recipientEmail);
  const recipientEmail = (recipient.email || input.recipientEmail).toLowerCase();
  const db = getTicketingDb();
  const keyHash = hashText(`${params.actorUid}:${input.idempotencyKey}`);
  const payloadHash = hashJson({
    action: "issueCompTicket",
    actorUid: params.actorUid,
    showId: input.showId,
    ticketTypeId: input.ticketTypeId,
    recipientUid: recipient.uid,
    recipientEmail,
    recipientName: input.recipientName,
    quantity: input.quantity,
    note: input.note ?? null,
  });
  const idempotencyRef = db
    .collection("idempotencyKeys")
    .doc(`issueCompTicket_${keyHash}`);
  const showRef = db.collection("shows").doc(input.showId);
  const ticketTypeRef = showRef
    .collection("ticketTypes")
    .doc(input.ticketTypeId);

  return db.runTransaction(async (tx): Promise<IssueCompTicketResult> => {
    const idempotencySnap = await tx.get(idempotencyRef);
    if (idempotencySnap.exists) {
      const existing = idempotencySnap.data() as ExistingIdempotencyRecord;
      if (existing.payloadHash !== payloadHash) {
        throw new HttpsError(
          "already-exists",
          "This idempotency key was already used for a different comp ticket request.",
        );
      }
      return existingResult(existing);
    }

    const [showSnap, ticketTypeSnap] = await Promise.all([
      tx.get(showRef),
      tx.get(ticketTypeRef),
    ]);
    if (!showSnap.exists) {
      throw new HttpsError("not-found", "Show not found.");
    }
    if (!ticketTypeSnap.exists) {
      throw new HttpsError("not-found", "Ticket type not found.");
    }

    const show = showSnap.data() as TicketedShowData;
    const ticketType = ticketTypeSnap.data() as TicketTypeData;
    validateCompIssuable(show, ticketType, input.quantity);

    const orderRef = db.collection("orders").doc();
    const ticketRefs = Array.from({ length: input.quantity }, () =>
      db.collection("tickets").doc(),
    );
    const holders = buildHolders({ ...input, recipientEmail });
    const ticketIds = ticketRefs.map((ref) => ref.id);

    tx.update(ticketTypeRef, {
      quantitySold: FieldValue.increment(input.quantity),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(orderRef, {
      showId: input.showId,
      sellingFrontId: show.sellingFrontId,
      buyerUid: recipient.uid,
      buyerSnapshot: {
        email: recipientEmail,
        displayName: input.recipientName,
        suburb: null,
        email_opt_in: false,
        sms_opt_in: false,
        socials: {},
      },
      status: "paid",
      paymentType: "comp",
      lineItems: [
        {
          ticketTypeId: input.ticketTypeId,
          name: ticketType.name,
          quantity: input.quantity,
          priceCents: 0,
          bookingFeeCents: 0,
          subtotalCents: 0,
          bookingFeeTotalCents: 0,
          discountCents: 0,
          totalCents: 0,
        },
      ],
      holders,
      stripeCheckoutSessionId: null,
      stripeCheckoutSessionUrl: null,
      stripePaymentIntentId: null,
      subtotalCents: 0,
      bookingFeeCents: 0,
      discountCents: 0,
      promoCode: null,
      stripeFeeCents: null,
      totalCents: 0,
      currency: ticketType.currency,
      reservationExpiresAt: null,
      paidAt: FieldValue.serverTimestamp(),
      compIssue: {
        issuedByUid: params.actorUid,
        issuedAt: FieldValue.serverTimestamp(),
        recipientUid: recipient.uid,
        recipientEmail,
        recipientName: input.recipientName,
        note: input.note ?? null,
        idempotencyKeyHash: keyHash,
      },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(orderRef.collection("payments").doc("comp"), {
      type: "comp",
      stripeId: null,
      amountCents: 0,
      feeCents: null,
      status: "succeeded",
      createdAt: FieldValue.serverTimestamp(),
      reason: input.note ?? "Comp ticket issued",
      issuedByUid: params.actorUid,
    });

    holders.forEach((holder, index) => {
      tx.set(
        ticketRefs[index],
        buildIssuedTicketData({
          orderId: orderRef.id,
          showId: input.showId,
          sellingFrontId: show.sellingFrontId,
          ticketTypeId: input.ticketTypeId,
          holder,
          holderMemberUid: recipient.uid,
          holderConsentSource: "comp_issue",
        }),
      );
    });

    tx.set(idempotencyRef, {
      action: "issueCompTicket",
      actorUid: params.actorUid,
      keyHash,
      payloadHash,
      status: "succeeded",
      orderId: orderRef.id,
      ticketIds,
      recipientUid: recipient.uid,
      recipientEmail,
      recipientName: input.recipientName,
      showId: input.showId,
      ticketTypeId: input.ticketTypeId,
      quantity: input.quantity,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection("auditLog").doc(), {
      actorUid: params.actorUid,
      action: "comp_issue",
      targetType: "order",
      targetId: orderRef.id,
      before: null,
      after: {
        status: "paid",
        paymentType: "comp",
        totalCents: 0,
        ticketCount: input.quantity,
        ticketIds,
        showId: input.showId,
        ticketTypeId: input.ticketTypeId,
        recipientUid: recipient.uid,
        recipientEmail,
        recipientName: input.recipientName,
      },
      reason: input.note ?? "Comp ticket issued",
      serverTimestamp: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      orderId: orderRef.id,
      ticketIds,
      recipientUid: recipient.uid,
      recipientEmail,
      showId: input.showId,
      ticketTypeId: input.ticketTypeId,
      quantity: input.quantity,
      idempotent: false,
      note: "Comp ticket issued.",
    };
  });
}

export const issueCompTicket = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
  },
  async (request): Promise<IssueCompTicketResult> => {
    const authRequest = requireAuth(request, ["platform_admin", "event_admin"], {
      keyPrefix: "issueCompTicket",
      maxCalls: 20,
      windowMs: 60 * 1000,
    });

    return issueCompTicketAsAdmin({
      actorUid: authRequest.auth.uid,
      data: request.data,
    });
  },
);
