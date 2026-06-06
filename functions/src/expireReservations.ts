import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getTicketingDb, REGION } from "./ticketing/config";
import {
  PromoCodeData,
  TicketOrderData,
  TicketTypeData,
} from "./ticketing/shared";

export type ExpireReservationsResult = {
  scanned: number;
  expired: number;
  skipped: number;
};

export async function expirePendingReservations(
  limit = 50,
): Promise<ExpireReservationsResult> {
  const db = getTicketingDb();
  const now = Timestamp.now();
  const snapshot = await db
    .collection("orders")
    .where("status", "==", "pending")
    .where("reservationExpiresAt", "<", now)
    .limit(limit)
    .get();

  let expired = 0;
  let skipped = 0;

  for (const orderDoc of snapshot.docs) {
    const didExpire = await db.runTransaction(async (tx) => {
      const orderRef = orderDoc.ref;
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) {
        return false;
      }

      const order = orderSnap.data() as TicketOrderData;
      if (order.status !== "pending") {
        return false;
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
      if (promoRef && promoSnap?.exists) {
        const promo = promoSnap.data() as PromoCodeData;
        tx.update(promoRef, {
          reservationCount: Math.max(
            0,
            Number(promo.reservationCount ?? 0) - 1,
          ),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      if (!ticketTypeSnap.exists) {
        tx.update(orderRef, {
          status: "cancelled",
          cancelledReason: "reservation expired; ticket type missing",
          updatedAt: FieldValue.serverTimestamp(),
        });
        return true;
      }

      const ticketType = ticketTypeSnap.data() as TicketTypeData;
      const reserved = Number(ticketType.quantityReserved ?? 0);
      tx.update(ticketTypeRef, {
        quantityReserved: Math.max(0, reserved - lineItem.quantity),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(orderRef, {
        status: "cancelled",
        cancelledReason: "reservation expired",
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(db.collection("auditLog").doc(), {
        actorUid: "system",
        action: "reservation_expire",
        targetType: "order",
        targetId: orderRef.id,
        before: { status: order.status },
        after: { status: "cancelled" },
        reason: "reservationExpiresAt elapsed",
        serverTimestamp: FieldValue.serverTimestamp(),
      });
      return true;
    });

    if (didExpire) {
      expired += 1;
    } else {
      skipped += 1;
    }
  }

  return {
    scanned: snapshot.size,
    expired,
    skipped,
  };
}

export const expireReservations = onSchedule(
  {
    region: REGION,
    schedule: "every 30 minutes",
  },
  async () => {
    const result = await expirePendingReservations();
    logger.info("Expired stale ticket reservations", result);
  },
);
