import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import {
  getStripeClient,
  getStripeWebhookSecret,
  getTicketingDb,
  REGION,
  PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
} from "./ticketing/config";
import {
  generateQrToken,
  hashQrToken,
  PromoCodeData,
  TicketOrderData,
  TicketTypeData,
} from "./ticketing/shared";
import { syncPrisTicketingPurchase } from "./syncPrisTicketingPurchase";

type StripeEvent = {
  id: string;
  type: string;
  data: { object: unknown };
  [key: string]: unknown;
};

type StripeCheckoutSession = {
  id: string;
  client_reference_id?: string | null;
  metadata?: Record<string, string | undefined> | null;
  payment_intent?: string | { id?: string } | null;
};

type StripePaymentIntent = {
  metadata?: Record<string, string | undefined> | null;
};

type StripeCharge = {
  id: string;
  amount?: number | null;
  amount_refunded?: number | null;
  metadata?: Record<string, string | undefined> | null;
  payment_intent?: string | { id?: string } | null;
};

type StripeDispute = {
  id: string;
  amount?: number | null;
  currency?: string | null;
  charge?: string | { id?: string } | null;
  metadata?: Record<string, string | undefined> | null;
  payment_intent?: string | { id?: string } | null;
  reason?: string | null;
  status?: string | null;
};

type ProcessStripeEventResult = {
  ok: true;
  status: "processed" | "duplicate" | "ignored" | "failed";
  eventId: string;
  relatedOrderId?: string | null;
  note?: string;
};

function readStripeObjectId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

function getOrderIdFromStripeObject(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const object = value as {
    client_reference_id?: unknown;
    metadata?: Record<string, string | undefined>;
  };
  return (
    object.metadata?.orderId ||
    (typeof object.client_reference_id === "string"
      ? object.client_reference_id
      : null) ||
    null
  );
}

function getPaymentIntentIdFromStripeObject(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const object = value as { payment_intent?: unknown };
  return readStripeObjectId(object.payment_intent);
}

async function findOrderIdByPaymentIntent(
  paymentIntentId: string | null,
): Promise<string | null> {
  if (!paymentIntentId) {
    return null;
  }
  const snap = await getTicketingDb()
    .collection("orders")
    .where("stripePaymentIntentId", "==", paymentIntentId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

async function resolveOrderIdFromPaymentObject(
  value: unknown,
): Promise<string | null> {
  return (
    getOrderIdFromStripeObject(value) ||
    (await findOrderIdByPaymentIntent(
      getPaymentIntentIdFromStripeObject(value),
    ))
  );
}

async function recordStripeEvent(params: {
  event: StripeEvent;
  status: "processed" | "ignored" | "failed";
  relatedOrderId?: string | null;
  note?: string;
}): Promise<ProcessStripeEventResult> {
  const db = getTicketingDb();
  const eventRef = db.collection("stripeEvents").doc(params.event.id);

  return db.runTransaction(async (tx) => {
    const eventSnap = await tx.get(eventRef);
    if (eventSnap.exists) {
      return {
        ok: true,
        status: "duplicate",
        eventId: params.event.id,
        relatedOrderId:
          eventSnap.data()?.relatedOrderId ?? params.relatedOrderId ?? null,
        note: "stripe event already recorded",
      };
    }

    tx.set(eventRef, {
      type: params.event.type,
      processedAt: FieldValue.serverTimestamp(),
      status: params.status,
      relatedOrderId: params.relatedOrderId ?? null,
      note: params.note ?? null,
    });

    return {
      ok: true,
      status: params.status,
      eventId: params.event.id,
      relatedOrderId: params.relatedOrderId ?? null,
      note: params.note,
    };
  });
}

async function issueTicketsForPaidOrder(
  event: StripeEvent,
  session: StripeCheckoutSession,
): Promise<ProcessStripeEventResult> {
  const db = getTicketingDb();
  const orderId = getOrderIdFromStripeObject(session);
  if (!orderId) {
    return recordStripeEvent({
      event,
      status: "failed",
      note: "checkout session missing orderId metadata",
    });
  }

  const eventRef = db.collection("stripeEvents").doc(event.id);
  const orderRef = db.collection("orders").doc(orderId);

  const result: ProcessStripeEventResult = await db.runTransaction(
    async (tx): Promise<ProcessStripeEventResult> => {
      const [eventSnap, orderSnap] = await Promise.all([
        tx.get(eventRef),
        tx.get(orderRef),
      ]);
      if (eventSnap.exists) {
        return {
          ok: true,
          status: "duplicate",
          eventId: event.id,
          relatedOrderId: orderId,
          note: "stripe event already processed",
        };
      }
      if (!orderSnap.exists) {
        tx.set(eventRef, {
          type: event.type,
          processedAt: FieldValue.serverTimestamp(),
          status: "failed",
          relatedOrderId: orderId,
          note: "order not found",
        });
        return {
          ok: true,
          status: "failed",
          eventId: event.id,
          relatedOrderId: orderId,
          note: "order not found",
        };
      }

      const order = orderSnap.data() as TicketOrderData;
      if (order.status === "paid") {
        tx.set(eventRef, {
          type: event.type,
          processedAt: FieldValue.serverTimestamp(),
          status: "ignored",
          relatedOrderId: orderId,
          note: "order already paid",
        });
        return {
          ok: true,
          status: "ignored",
          eventId: event.id,
          relatedOrderId: orderId,
          note: "order already paid",
        };
      }
      if (order.status !== "pending") {
        tx.set(eventRef, {
          type: event.type,
          processedAt: FieldValue.serverTimestamp(),
          status: "ignored",
          relatedOrderId: orderId,
          note: `order status is ${order.status}`,
        });
        return {
          ok: true,
          status: "ignored",
          eventId: event.id,
          relatedOrderId: orderId,
          note: `order status is ${order.status}`,
        };
      }

      const lineItem = order.lineItems[0];
      const quantity = lineItem.quantity;
      const ticketTypeRef = db
        .collection("shows")
        .doc(order.showId)
        .collection("ticketTypes")
        .doc(lineItem.ticketTypeId);
      const ticketTypeSnap = await tx.get(ticketTypeRef);
      if (!ticketTypeSnap.exists) {
        tx.set(eventRef, {
          type: event.type,
          processedAt: FieldValue.serverTimestamp(),
          status: "failed",
          relatedOrderId: orderId,
          note: "ticket type not found",
        });
        return {
          ok: true,
          status: "failed",
          eventId: event.id,
          relatedOrderId: orderId,
          note: "ticket type not found",
        };
      }

      const ticketType = ticketTypeSnap.data() as TicketTypeData;
      const promoCodeId = order.promoCode?.id;
      const promoRef = promoCodeId
        ? db
            .collection("shows")
            .doc(order.showId)
            .collection("promoCodes")
            .doc(promoCodeId)
        : null;
      const promoSnap = promoRef ? await tx.get(promoRef) : null;
      const holders =
        order.holders && order.holders.length === quantity
          ? order.holders
          : Array.from({ length: quantity }, (_, index) => ({
              holderName:
                index === 0
                  ? order.buyerSnapshot.displayName || "Ticket Holder"
                  : `Guest ${index + 1}`,
              holderEmail: order.buyerSnapshot.email || "",
              holderPhone: null,
              holderEmailOptIn: false,
              holderSmsOptIn: false,
            }));
      const reserved = Number(ticketType.quantityReserved ?? 0);
      const sold = Number(ticketType.quantitySold ?? 0);
      const paymentIntentId = readStripeObjectId(session.payment_intent);

      tx.update(ticketTypeRef, {
        quantityReserved: Math.max(0, reserved - quantity),
        quantitySold: sold + quantity,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (promoRef && promoSnap?.exists) {
        const promo = promoSnap.data() as PromoCodeData;
        tx.update(promoRef, {
          reservationCount: Math.max(
            0,
            Number(promo.reservationCount ?? 0) - 1,
          ),
          redemptionCount: Number(promo.redemptionCount ?? 0) + 1,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(orderRef, {
        status: "paid",
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: paymentIntentId,
        paidAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(
        orderRef.collection("payments").doc(paymentIntentId || session.id),
        {
          type: "charge",
          stripeId: paymentIntentId || session.id,
          amountCents: order.totalCents,
          feeCents: null,
          status: "succeeded",
          createdAt: FieldValue.serverTimestamp(),
          reason: null,
        },
      );

      holders.forEach((holder) => {
        const ticketRef = db.collection("tickets").doc();
        const qrToken = generateQrToken();
        tx.set(ticketRef, {
          orderId,
          showId: order.showId,
          sellingFrontId: order.sellingFrontId,
          ticketTypeId: lineItem.ticketTypeId,
          holderName: holder.holderName,
          holderEmail: holder.holderEmail,
          holderPhone: holder.holderPhone ?? null,
          holderEmailOptIn: holder.holderEmailOptIn === true,
          holderSmsOptIn: holder.holderSmsOptIn === true,
          holderConsentSource: "ticket_purchase",
          holderConsentAt:
            holder.holderEmailOptIn || holder.holderSmsOptIn
              ? FieldValue.serverTimestamp()
              : null,
          holderMemberUid:
            holder.holderEmail === order.buyerSnapshot.email
              ? order.buyerUid
              : null,
          status: "valid",
          qrToken,
          qrTokenHash: hashQrToken(qrToken),
          issuedAt: FieldValue.serverTimestamp(),
          usedAt: null,
          usedByStaffUid: null,
        });
      });

      tx.set(eventRef, {
        type: event.type,
        processedAt: FieldValue.serverTimestamp(),
        status: "processed",
        relatedOrderId: orderId,
      });
      tx.set(db.collection("auditLog").doc(), {
        actorUid: "stripe",
        action: "ticket_issue",
        targetType: "order",
        targetId: orderId,
        before: { status: order.status },
        after: { status: "paid", ticketCount: quantity },
        reason: "checkout.session.completed",
        serverTimestamp: FieldValue.serverTimestamp(),
      });

      return {
        ok: true,
        status: "processed",
        eventId: event.id,
        relatedOrderId: orderId,
      };
    },
  );

  if (result.status === "processed") {
    try {
      await syncPrisTicketingPurchase(orderId);
    } catch (error) {
      logger.warn("PRIS ticketing purchase sync failed after ticket issue", {
        orderId,
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function releaseExpiredCheckoutSession(
  event: StripeEvent,
  session: StripeCheckoutSession,
): Promise<ProcessStripeEventResult> {
  const db = getTicketingDb();
  const orderId = getOrderIdFromStripeObject(session);
  if (!orderId) {
    return recordStripeEvent({
      event,
      status: "failed",
      note: "checkout session missing orderId metadata",
    });
  }

  const eventRef = db.collection("stripeEvents").doc(event.id);
  const orderRef = db.collection("orders").doc(orderId);

  return db.runTransaction(async (tx) => {
    const [eventSnap, orderSnap] = await Promise.all([
      tx.get(eventRef),
      tx.get(orderRef),
    ]);
    if (eventSnap.exists) {
      return {
        ok: true,
        status: "duplicate",
        eventId: event.id,
        relatedOrderId: orderId,
      };
    }
    if (!orderSnap.exists) {
      tx.set(eventRef, {
        type: event.type,
        processedAt: FieldValue.serverTimestamp(),
        status: "failed",
        relatedOrderId: orderId,
        note: "order not found",
      });
      return {
        ok: true,
        status: "failed",
        eventId: event.id,
        relatedOrderId: orderId,
        note: "order not found",
      };
    }

    const order = orderSnap.data() as TicketOrderData;
    if (order.status !== "pending") {
      tx.set(eventRef, {
        type: event.type,
        processedAt: FieldValue.serverTimestamp(),
        status: "ignored",
        relatedOrderId: orderId,
        note: `order status is ${order.status}`,
      });
      return {
        ok: true,
        status: "ignored",
        eventId: event.id,
        relatedOrderId: orderId,
        note: `order status is ${order.status}`,
      };
    }

    const lineItem = order.lineItems[0];
    const ticketTypeRef = db
      .collection("shows")
      .doc(order.showId)
      .collection("ticketTypes")
      .doc(lineItem.ticketTypeId);
    const promoCodeId = order.promoCode?.id;
    const promoRef = promoCodeId
      ? db
          .collection("shows")
          .doc(order.showId)
          .collection("promoCodes")
          .doc(promoCodeId)
      : null;
    const [ticketTypeSnap, promoSnap] = await Promise.all([
      tx.get(ticketTypeRef),
      promoRef ? tx.get(promoRef) : Promise.resolve(null),
    ]);
    const ticketType = ticketTypeSnap.data() as TicketTypeData | undefined;
    const reserved = Number(ticketType?.quantityReserved ?? 0);

    if (ticketTypeSnap.exists) {
      tx.update(ticketTypeRef, {
        quantityReserved: Math.max(0, reserved - lineItem.quantity),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (promoRef && promoSnap?.exists) {
      const promo = promoSnap.data() as PromoCodeData;
      tx.update(promoRef, {
        reservationCount: Math.max(0, Number(promo.reservationCount ?? 0) - 1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(orderRef, {
      status: "cancelled",
      cancelledReason: "checkout.session.expired",
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(eventRef, {
      type: event.type,
      processedAt: FieldValue.serverTimestamp(),
      status: "processed",
      relatedOrderId: orderId,
    });

    return {
      ok: true,
      status: "processed",
      eventId: event.id,
      relatedOrderId: orderId,
    };
  });
}

async function markFailedPayment(
  event: StripeEvent,
): Promise<ProcessStripeEventResult> {
  const paymentIntent = event.data.object as StripePaymentIntent;
  const orderId = paymentIntent.metadata?.orderId ?? null;
  if (!orderId) {
    return recordStripeEvent({
      event,
      status: "ignored",
      note: "payment_intent.payment_failed missing orderId metadata",
    });
  }

  return recordStripeEvent({
    event,
    status: "processed",
    relatedOrderId: orderId,
    note: "payment failed; reservation expiry handles inventory release",
  });
}

async function reconcileChargeRefunded(
  event: StripeEvent,
  charge: StripeCharge,
): Promise<ProcessStripeEventResult> {
  const db = getTicketingDb();
  const orderId = await resolveOrderIdFromPaymentObject(charge);
  if (!orderId) {
    return recordStripeEvent({
      event,
      status: "ignored",
      note: "charge.refunded could not be mapped to an order",
    });
  }

  const eventRef = db.collection("stripeEvents").doc(event.id);
  const orderRef = db.collection("orders").doc(orderId);

  return db.runTransaction(async (tx) => {
    const [eventSnap, orderSnap] = await Promise.all([
      tx.get(eventRef),
      tx.get(orderRef),
    ]);
    if (eventSnap.exists) {
      return {
        ok: true,
        status: "duplicate",
        eventId: event.id,
        relatedOrderId: orderId,
      };
    }
    if (!orderSnap.exists) {
      tx.set(eventRef, {
        type: event.type,
        processedAt: FieldValue.serverTimestamp(),
        status: "failed",
        relatedOrderId: orderId,
        note: "order not found",
      });
      return {
        ok: true,
        status: "failed",
        eventId: event.id,
        relatedOrderId: orderId,
        note: "order not found",
      };
    }

    const order = orderSnap.data() as TicketOrderData;
    if (order.status === "refunded") {
      tx.set(eventRef, {
        type: event.type,
        processedAt: FieldValue.serverTimestamp(),
        status: "ignored",
        relatedOrderId: orderId,
        note: "order already marked refunded",
      });
      return {
        ok: true,
        status: "ignored",
        eventId: event.id,
        relatedOrderId: orderId,
        note: "order already marked refunded",
      };
    }

    const amountRefunded = Number(charge.amount_refunded ?? 0);
    const isFullRefund = amountRefunded >= Number(order.totalCents ?? 0);
    const nextStatus = isFullRefund ? "refunded" : "partially_refunded";

    if (isFullRefund) {
      const lineItem = order.lineItems[0];
      const ticketTypeRef = db
        .collection("shows")
        .doc(order.showId)
        .collection("ticketTypes")
        .doc(lineItem.ticketTypeId);
      const [ticketTypeSnap, ticketSnap] = await Promise.all([
        tx.get(ticketTypeRef),
        tx.get(db.collection("tickets").where("orderId", "==", orderId)),
      ]);
      const returnableTickets = ticketSnap.docs.filter(
        (doc) => doc.data().status !== "used",
      );
      if (ticketTypeSnap.exists && returnableTickets.length > 0) {
        const ticketType = ticketTypeSnap.data() as TicketTypeData;
        tx.update(ticketTypeRef, {
          quantitySold: Math.max(
            0,
            Number(ticketType.quantitySold ?? 0) - returnableTickets.length,
          ),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      for (const ticketDoc of ticketSnap.docs) {
        tx.update(ticketDoc.ref, {
          status: "refunded",
          refundedAt: FieldValue.serverTimestamp(),
          refundedByUid: "stripe",
        });
      }
    }

    tx.update(orderRef, {
      status: nextStatus,
      refundedCents: amountRefunded,
      updatedAt: FieldValue.serverTimestamp(),
      ...(isFullRefund ? { refundedAt: FieldValue.serverTimestamp() } : {}),
    });
    tx.set(orderRef.collection("payments").doc(event.id), {
      type: "refund",
      stripeId: charge.id,
      amountCents: amountRefunded,
      feeCents: null,
      status: "refunded",
      createdAt: FieldValue.serverTimestamp(),
      reason: "charge.refunded webhook",
    });
    tx.set(eventRef, {
      type: event.type,
      processedAt: FieldValue.serverTimestamp(),
      status: "processed",
      relatedOrderId: orderId,
      note: isFullRefund
        ? "full refund reconciled"
        : "partial external refund recorded; tickets unchanged",
    });
    tx.set(db.collection("auditLog").doc(), {
      actorUid: "stripe",
      action: "refund",
      targetType: "order",
      targetId: orderId,
      before: { status: order.status },
      after: { status: nextStatus, amountRefunded },
      reason: "charge.refunded",
      serverTimestamp: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      status: "processed",
      eventId: event.id,
      relatedOrderId: orderId,
      note: isFullRefund
        ? "full refund reconciled"
        : "partial external refund recorded; tickets unchanged",
    };
  });
}

async function reconcileDispute(
  event: StripeEvent,
  dispute: StripeDispute,
): Promise<ProcessStripeEventResult> {
  const db = getTicketingDb();
  const orderId = await resolveOrderIdFromPaymentObject(dispute);
  if (!orderId) {
    return recordStripeEvent({
      event,
      status: "ignored",
      note: `${event.type} could not be mapped to an order`,
    });
  }

  const eventRef = db.collection("stripeEvents").doc(event.id);
  const orderRef = db.collection("orders").doc(orderId);

  return db.runTransaction(async (tx) => {
    const [eventSnap, orderSnap] = await Promise.all([
      tx.get(eventRef),
      tx.get(orderRef),
    ]);
    if (eventSnap.exists) {
      return {
        ok: true,
        status: "duplicate",
        eventId: event.id,
        relatedOrderId: orderId,
      };
    }
    if (!orderSnap.exists) {
      tx.set(eventRef, {
        type: event.type,
        processedAt: FieldValue.serverTimestamp(),
        status: "failed",
        relatedOrderId: orderId,
        note: "order not found",
      });
      return {
        ok: true,
        status: "failed",
        eventId: event.id,
        relatedOrderId: orderId,
        note: "order not found",
      };
    }

    const order = orderSnap.data() as TicketOrderData;
    const disputeStatus = dispute.status ?? "unknown";
    const won =
      event.type === "charge.dispute.closed" && disputeStatus === "won";
    const lost =
      event.type === "charge.dispute.closed" && disputeStatus === "lost";
    const nextOrderStatus = won ? "paid" : "disputed";
    const nextTicketStatus = won
      ? "valid"
      : lost
        ? "lost_to_dispute"
        : "disputed";

    const ticketSnap = await tx.get(
      db.collection("tickets").where("orderId", "==", orderId),
    );
    for (const ticketDoc of ticketSnap.docs) {
      const currentStatus = ticketDoc.data().status;
      if (won && currentStatus !== "disputed") {
        continue;
      }
      if (!won && currentStatus === "used") {
        continue;
      }
      tx.update(ticketDoc.ref, {
        status: nextTicketStatus,
        disputeId: dispute.id,
        disputedAt: FieldValue.serverTimestamp(),
      });
    }

    tx.update(orderRef, {
      status: nextOrderStatus,
      stripeDisputeId: dispute.id,
      disputeStatus,
      disputedCents: Number(dispute.amount ?? 0),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      orderRef.collection("payments").doc(dispute.id),
      {
        type: "dispute",
        stripeId: dispute.id,
        amountCents: Number(dispute.amount ?? 0),
        feeCents: null,
        status: "disputed",
        createdAt: FieldValue.serverTimestamp(),
        reason: dispute.reason ?? event.type,
      },
      { merge: true },
    );
    tx.set(eventRef, {
      type: event.type,
      processedAt: FieldValue.serverTimestamp(),
      status: "processed",
      relatedOrderId: orderId,
      note: `dispute ${disputeStatus}`,
    });
    tx.set(db.collection("auditLog").doc(), {
      actorUid: "stripe",
      action: "refund",
      targetType: "order",
      targetId: orderId,
      before: { status: order.status },
      after: {
        status: nextOrderStatus,
        ticketStatus: nextTicketStatus,
        disputeStatus,
      },
      reason: event.type,
      serverTimestamp: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      status: "processed",
      eventId: event.id,
      relatedOrderId: orderId,
      note: `dispute ${disputeStatus}`,
    };
  });
}

export async function processStripeEvent(
  event: StripeEvent,
): Promise<ProcessStripeEventResult> {
  switch (event.type) {
    case "checkout.session.completed":
      return issueTicketsForPaidOrder(
        event,
        event.data.object as StripeCheckoutSession,
      );
    case "checkout.session.expired":
      return releaseExpiredCheckoutSession(
        event,
        event.data.object as StripeCheckoutSession,
      );
    case "payment_intent.payment_failed":
      return markFailedPayment(event);
    case "charge.refunded":
      return reconcileChargeRefunded(event, event.data.object as StripeCharge);
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      return reconcileDispute(event, event.data.object as StripeDispute);
    default:
      return recordStripeEvent({
        event,
        status: "ignored",
        relatedOrderId: getOrderIdFromStripeObject(event.data.object),
        note: "event type not handled in Phase 2",
      });
  }
}

export const stripeWebhook = onRequest(
  {
    region: REGION,
    secrets: [
      STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET,
      PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET,
    ],
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).send("Method Not Allowed");
      return;
    }

    const signature = request.header("stripe-signature");
    const webhookSecret = getStripeWebhookSecret();
    if (!signature || !webhookSecret) {
      response
        .status(400)
        .send("Stripe webhook signature configuration missing.");
      return;
    }

    let event: StripeEvent;
    try {
      event = getStripeClient().webhooks.constructEvent(
        request.rawBody,
        signature,
        webhookSecret,
      ) as unknown as StripeEvent;
    } catch (error) {
      logger.warn("Stripe webhook signature verification failed", { error });
      response.status(400).send("Webhook signature verification failed.");
      return;
    }

    try {
      const result = await processStripeEvent(event);
      logger.info("Stripe webhook processed", {
        eventId: event.id,
        type: event.type,
        status: result.status,
        relatedOrderId: result.relatedOrderId ?? null,
      });
      response.status(200).json(result);
    } catch (error) {
      logger.error("Stripe webhook processing failed", {
        eventId: event.id,
        type: event.type,
        error,
      });
      response.status(500).send("Webhook processing failed.");
    }
  },
);

export function buildCheckoutCompletedEvent(params: {
  eventId: string;
  orderId: string;
  sessionId: string;
  paymentIntentId: string;
}): StripeEvent {
  return {
    id: params.eventId,
    object: "event",
    api_version: null,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: params.sessionId,
        object: "checkout.session",
        client_reference_id: params.orderId,
        metadata: { orderId: params.orderId },
        mode: "payment",
        payment_intent: params.paymentIntentId,
        payment_status: "paid",
        status: "complete",
      } as StripeCheckoutSession,
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "checkout.session.completed",
  };
}

export function buildCheckoutExpiredEvent(params: {
  eventId: string;
  orderId: string;
  sessionId: string;
}): StripeEvent {
  return {
    id: params.eventId,
    object: "event",
    api_version: null,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: params.sessionId,
        object: "checkout.session",
        client_reference_id: params.orderId,
        metadata: { orderId: params.orderId },
        mode: "payment",
        payment_status: "unpaid",
        status: "expired",
        expires_at: Timestamp.now().seconds,
      } as StripeCheckoutSession,
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "checkout.session.expired",
  };
}
