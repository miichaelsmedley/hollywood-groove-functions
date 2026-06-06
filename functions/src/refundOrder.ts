// refundOrder — ticketing-admin full-order refunds.
//
// This is intentionally narrow for the first live-payments hardening pass:
// platform admins and event admins can refund a paid order in full, and tickets
// are invalidated server-side. Partial / per-ticket refunds need an order-detail
// UI so an admin can see exactly which seats/tickets are being touched.

import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import {
  getStripeClient,
  getTicketingDb,
  REGION,
  shouldUseMockStripeCheckout,
  STRIPE_SECRET_KEY,
} from "./ticketing/config";
import { asRecord, nonEmptyString, TicketOrderData, TicketTypeData } from "./ticketing/shared";

type StripeRefundReason = "duplicate" | "fraudulent" | "requested_by_customer";
type RefundStatus = "pending" | "succeeded" | "failed" | "cancelled";

const STRIPE_REFUND_REASONS = new Set<StripeRefundReason>([
  "duplicate",
  "fraudulent",
  "requested_by_customer",
]);

type RefundOrderInput = {
  orderId: string;
  reason: string;
  stripeReason: StripeRefundReason;
  forceAfterScan: boolean;
};

type PendingRefund = {
  refundId: string;
  orderId: string;
  paymentIntentId: string;
  amountCents: number;
  bookingFeeRefundedCents: number;
  stripeFeeNotReturnedCents: number;
  ticketIds: string[];
  reason: string;
  stripeReason: StripeRefundReason;
  forceAfterScan: boolean;
};

type StripeRefundResult = {
  id: string;
  status: RefundStatus;
};

type RefundOrderResult = {
  ok: true;
  refundId: string;
  stripeRefundId: string;
  orderId: string;
  status: RefundStatus;
  amountCents: number;
  ticketIds: string[];
  note: string;
};

function normaliseBoolean(value: unknown): boolean {
  return value === true;
}

function validateInput(data: unknown): RefundOrderInput {
  const record = asRecord(data);
  const orderId = nonEmptyString(record.orderId);
  if (!orderId) {
    throw new HttpsError("invalid-argument", "orderId is required.");
  }

  const reason = nonEmptyString(record.reason) ?? "Customer requested refund";
  const stripeReasonRaw = nonEmptyString(record.stripeReason) ?? "requested_by_customer";
  if (!STRIPE_REFUND_REASONS.has(stripeReasonRaw as StripeRefundReason)) {
    throw new HttpsError("invalid-argument", "stripeReason must be duplicate, fraudulent, or requested_by_customer.");
  }

  return {
    orderId,
    reason,
    stripeReason: stripeReasonRaw as StripeRefundReason,
    forceAfterScan: normaliseBoolean(record.forceAfterScan),
  };
}

function normaliseRefundStatus(status: unknown): RefundStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "canceled" || status === "cancelled") return "cancelled";
  return "pending";
}

async function createPendingRefund(params: {
  input: RefundOrderInput;
  actorUid: string;
}): Promise<PendingRefund> {
  const db = getTicketingDb();
  const orderRef = db.collection("orders").doc(params.input.orderId);
  const refundRef = db.collection("refunds").doc();

  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }

    const order = orderSnap.data() as TicketOrderData;
    if (order.status !== "paid") {
      throw new HttpsError("failed-precondition", "Only paid, unrefunded orders can be refunded by this MVP flow.");
    }
    if (!order.stripePaymentIntentId) {
      throw new HttpsError("failed-precondition", "Order has no Stripe PaymentIntent id.");
    }
    if (order.currency !== "AUD") {
      throw new HttpsError("failed-precondition", "Only AUD orders can be refunded.");
    }
    if (!Array.isArray(order.lineItems) || order.lineItems.length !== 1) {
      throw new HttpsError("failed-precondition", "Only single-ticket-type orders can be refunded by this MVP flow.");
    }

    const existingRefunds = await tx.get(
      db.collection("refunds")
        .where("orderId", "==", params.input.orderId)
    );
    const activeRefund = existingRefunds.docs.find((doc) => {
      const status = doc.data().status;
      return status === "pending" || status === "succeeded";
    });
    if (activeRefund) {
      throw new HttpsError("failed-precondition", "This order already has a pending or completed refund.");
    }

    const ticketSnap = await tx.get(
      db.collection("tickets")
        .where("orderId", "==", params.input.orderId)
    );
    if (ticketSnap.empty) {
      throw new HttpsError("failed-precondition", "No issued tickets were found for this order.");
    }

    const usedTickets = ticketSnap.docs.filter((doc) => doc.data().status === "used");
    if (usedTickets.length > 0 && !params.input.forceAfterScan) {
      throw new HttpsError(
        "failed-precondition",
        "At least one ticket has already been scanned. Use forceAfterScan only for deliberate post-entry refunds."
      );
    }

    const totalCents = Number(order.totalCents ?? 0);
    if (!Number.isInteger(totalCents) || totalCents <= 0) {
      throw new HttpsError("failed-precondition", "Order total is not refundable.");
    }

    const ticketIds = ticketSnap.docs.map((doc) => doc.id);
    const bookingFeeRefundedCents = Number(order.bookingFeeCents ?? 0);
    const stripeFeeNotReturnedCents = Number(order.stripeFeeCents ?? 0);

    tx.set(refundRef, {
      orderId: params.input.orderId,
      ticketIds,
      amountCents: totalCents,
      bookingFeeRefundedCents,
      stripeFeeNotReturnedCents,
      reason: params.input.reason,
      stripeReason: params.input.stripeReason,
      forceAfterScan: params.input.forceAfterScan,
      stripeRefundId: null,
      status: "pending",
      initiatedByUid: params.actorUid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection("auditLog").doc(), {
      actorUid: params.actorUid,
      action: "refund",
      targetType: "order",
      targetId: params.input.orderId,
      before: { status: order.status },
      after: { refundId: refundRef.id, status: "pending", amountCents: totalCents },
      reason: params.input.reason,
      serverTimestamp: FieldValue.serverTimestamp(),
    });

    return {
      refundId: refundRef.id,
      orderId: params.input.orderId,
      paymentIntentId: order.stripePaymentIntentId,
      amountCents: totalCents,
      bookingFeeRefundedCents,
      stripeFeeNotReturnedCents,
      ticketIds,
      reason: params.input.reason,
      stripeReason: params.input.stripeReason,
      forceAfterScan: params.input.forceAfterScan,
    };
  });
}

async function createStripeRefund(pending: PendingRefund, actorUid: string): Promise<StripeRefundResult> {
  if (shouldUseMockStripeCheckout()) {
    return {
      id: `re_mock_${pending.refundId}`,
      status: "succeeded",
    };
  }

  const refund = await getStripeClient().refunds.create(
    {
      payment_intent: pending.paymentIntentId,
      amount: pending.amountCents,
      reason: pending.stripeReason,
      metadata: {
        orderId: pending.orderId,
        refundId: pending.refundId,
        actorUid,
        source: "hollywood_groove_admin",
      },
    },
    { idempotencyKey: `hg_refund_${pending.refundId}` }
  ) as { id?: string; status?: unknown };

  if (!refund.id) {
    throw new Error("Stripe did not return a refund id.");
  }

  return {
    id: refund.id,
    status: normaliseRefundStatus(refund.status),
  };
}

async function finalizeRefund(params: {
  pending: PendingRefund;
  stripeRefund: StripeRefundResult;
  actorUid: string;
}): Promise<void> {
  const db = getTicketingDb();
  const orderRef = db.collection("orders").doc(params.pending.orderId);
  const refundRef = db.collection("refunds").doc(params.pending.refundId);

  await db.runTransaction(async (tx) => {
    const [orderSnap, refundSnap] = await Promise.all([
      tx.get(orderRef),
      tx.get(refundRef),
    ]);
    if (!orderSnap.exists || !refundSnap.exists) {
      throw new HttpsError("not-found", "Order or refund record disappeared during refund finalisation.");
    }

    const order = orderSnap.data() as TicketOrderData;
    const lineItem = order.lineItems[0];
    const ticketTypeRef = db
      .collection("shows").doc(order.showId)
      .collection("ticketTypes").doc(lineItem.ticketTypeId);
    const [ticketTypeSnap, ticketSnap] = await Promise.all([
      tx.get(ticketTypeRef),
      tx.get(db.collection("tickets").where("orderId", "==", params.pending.orderId)),
    ]);

    tx.update(refundRef, {
      stripeRefundId: params.stripeRefund.id,
      status: params.stripeRefund.status,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(orderRef.collection("payments").doc(params.stripeRefund.id), {
      type: "refund",
      stripeId: params.stripeRefund.id,
      amountCents: params.pending.amountCents,
      feeCents: null,
      status: params.stripeRefund.status === "failed" ? "failed" : "refunded",
      createdAt: FieldValue.serverTimestamp(),
      reason: params.pending.reason,
    });

    if (params.stripeRefund.status !== "failed" && params.stripeRefund.status !== "cancelled") {
      const returnableTickets = ticketSnap.docs.filter((doc) => doc.data().status !== "used");
      if (ticketTypeSnap.exists && returnableTickets.length > 0) {
        const ticketType = ticketTypeSnap.data() as TicketTypeData;
        const quantitySold = Number(ticketType.quantitySold ?? 0);
        tx.update(ticketTypeRef, {
          quantitySold: Math.max(0, quantitySold - returnableTickets.length),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      for (const ticketDoc of ticketSnap.docs) {
        tx.update(ticketDoc.ref, {
          status: "refunded",
          refundedAt: FieldValue.serverTimestamp(),
          refundedByUid: params.actorUid,
        });
      }

      tx.update(orderRef, {
        status: "refunded",
        refundedAt: FieldValue.serverTimestamp(),
        refundedByUid: params.actorUid,
        refundedCents: params.pending.amountCents,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    tx.set(db.collection("auditLog").doc(), {
      actorUid: params.actorUid,
      action: params.pending.forceAfterScan ? "force_refund_after_scan" : "refund",
      targetType: "refund",
      targetId: params.pending.refundId,
      before: { orderStatus: order.status, refundStatus: refundSnap.data()?.status ?? null },
      after: {
        orderStatus: params.stripeRefund.status === "failed" || params.stripeRefund.status === "cancelled"
          ? order.status
          : "refunded",
        refundStatus: params.stripeRefund.status,
        stripeRefundId: params.stripeRefund.id,
        amountCents: params.pending.amountCents,
      },
      reason: params.pending.reason,
      serverTimestamp: FieldValue.serverTimestamp(),
    });
  });
}

async function markRefundFailed(params: {
  pending: PendingRefund;
  actorUid: string;
  error: unknown;
}): Promise<void> {
  const db = getTicketingDb();
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  await db.collection("refunds").doc(params.pending.refundId).update({
    status: "failed",
    failureMessage: message,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db.collection("auditLog").add({
    actorUid: params.actorUid,
    action: "refund",
    targetType: "refund",
    targetId: params.pending.refundId,
    before: { status: "pending" },
    after: { status: "failed" },
    reason: message,
    serverTimestamp: FieldValue.serverTimestamp(),
  });
}

export async function refundPaidOrderAsAdmin(params: {
  actorUid: string;
  data: unknown;
}): Promise<RefundOrderResult> {
  const input = validateInput(params.data);
  const pending = await createPendingRefund({
    input,
    actorUid: params.actorUid,
  });

  let stripeRefund: StripeRefundResult;
  try {
    stripeRefund = await createStripeRefund(pending, params.actorUid);
  } catch (error) {
    await markRefundFailed({ pending, actorUid: params.actorUid, error });
    logger.error("Stripe refund creation failed", {
      orderId: pending.orderId,
      refundId: pending.refundId,
      error,
    });
    throw new HttpsError("internal", "Could not create Stripe refund.");
  }

  await finalizeRefund({
    pending,
    stripeRefund,
    actorUid: params.actorUid,
  });

  return {
    ok: true,
    refundId: pending.refundId,
    stripeRefundId: stripeRefund.id,
    orderId: pending.orderId,
    status: stripeRefund.status,
    amountCents: pending.amountCents,
    ticketIds: pending.ticketIds,
    note: "Refund recorded. Stripe may take several business days to return funds to the cardholder.",
  };
}

export const refundOrder = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
    secrets: [STRIPE_SECRET_KEY],
  },
  async (request): Promise<RefundOrderResult> => {
    const authRequest = requireAuth(request, ["platform_admin", "event_admin"], {
      keyPrefix: "refundOrder",
      maxCalls: 10,
      windowMs: 60 * 1000,
    });

    return refundPaidOrderAsAdmin({
      actorUid: authRequest.auth.uid,
      data: request.data,
    });
  }
);
