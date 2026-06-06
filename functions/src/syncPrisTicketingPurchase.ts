import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import {
  getPrisApiBaseUrl,
  getPrisIntegrationSecret,
  getTicketingDb,
} from "./ticketing/config";
import {
  asRecord,
  nonEmptyString,
  normaliseEmail,
  TicketOrderData,
} from "./ticketing/shared";

type TicketDocData = {
  holderName?: string | null;
  holderEmail?: string | null;
  holderPhone?: string | null;
  holderEmailOptIn?: boolean;
  holderSmsOptIn?: boolean;
  status?: string | null;
  ticketTypeId?: string | null;
  issuedAt?: Timestamp | FieldValue | null;
};

function timestampToIso(value: unknown): string | null {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object" && value !== null && "seconds" in value) {
    const seconds = Number((value as { seconds?: unknown }).seconds);
    return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

async function prisRequest(path: string, body: Record<string, unknown>): Promise<unknown> {
  const secret = getPrisIntegrationSecret();
  if (!secret) {
    return { skipped: true, reason: "missing_pris_integration_secret" };
  }

  const response = await fetch(`${getPrisApiBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PRIS-Integration-Secret": secret,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }
  if (!response.ok) {
    throw new Error(`PRIS ticketing purchase sync failed (${response.status}): ${raw.slice(0, 300)}`);
  }
  return payload;
}

function showPrisGigId(showData: Record<string, unknown>): number | null {
  const pris = asRecord(showData.pris);
  const raw = pris.gigId ?? pris.gig_id ?? pris.prisGigId;
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

export async function syncPrisTicketingPurchase(orderId: string): Promise<unknown> {
  const db = getTicketingDb();
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    return { skipped: true, reason: "order_not_found" };
  }

  const order = orderSnap.data() as TicketOrderData;
  if (order.status !== "paid") {
    return { skipped: true, reason: `order_status_${order.status}` };
  }

  const [showSnap, ticketSnap] = await Promise.all([
    db.collection("shows").doc(order.showId).get(),
    db.collection("tickets").where("orderId", "==", orderId).get(),
  ]);
  const show = showSnap.exists ? asRecord(showSnap.data()) : {};
  const buyer = order.buyerSnapshot || {};
  const tickets = ticketSnap.docs.map((ticketDoc) => {
    const data = ticketDoc.data() as TicketDocData;
    return compact({
      id: ticketDoc.id,
      status: nonEmptyString(data.status) || null,
      ticketTypeId: nonEmptyString(data.ticketTypeId) || null,
      issuedAt: timestampToIso(data.issuedAt),
    });
  });
  const holders = ticketSnap.docs.map((ticketDoc) => {
    const data = ticketDoc.data() as TicketDocData;
    return compact({
      ticketId: ticketDoc.id,
      holderName: nonEmptyString(data.holderName) || null,
      holderEmail: normaliseEmail(data.holderEmail),
      holderPhone: nonEmptyString(data.holderPhone) || null,
      holderEmailOptIn: asBoolean(data.holderEmailOptIn),
      holderSmsOptIn: asBoolean(data.holderSmsOptIn),
    });
  }).filter((holder) => holder.holderEmail);

  const payload = {
    orderId,
    showId: order.showId,
    sellingFrontId: order.sellingFrontId,
    prisGigId: showPrisGigId(show),
    paidAt: timestampToIso(order.paidAt),
    totalCents: order.totalCents,
    currency: order.currency,
    ticketCount: tickets.length,
    lineItems: order.lineItems,
    buyer: compact({
      email: normaliseEmail(buyer.email),
      name: nonEmptyString(buyer.displayName) || null,
      suburb: nonEmptyString(buyer.suburb) || null,
      emailOptIn: asBoolean(buyer.email_opt_in),
      smsOptIn: asBoolean(buyer.sms_opt_in),
      socials: buyer.socials || {},
    }),
    holders,
    tickets,
    show: compact({
      title: nonEmptyString(show.title) || null,
      sellingFrontId: nonEmptyString(show.sellingFrontId) || null,
      startDate: timestampToIso(show.startDate),
      venueId: nonEmptyString(show.venueId) || null,
    }),
  };

  const result = await prisRequest("/api/integrations/hollywood-groove/ticketing-purchases", payload);
  await orderRef.set({
    prisAudienceSync: {
      syncedAt: FieldValue.serverTimestamp(),
      result,
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  logger.info("Synced ticketing purchase to PRIS", {
    orderId,
    showId: order.showId,
    ticketCount: tickets.length,
  });
  return result;
}
