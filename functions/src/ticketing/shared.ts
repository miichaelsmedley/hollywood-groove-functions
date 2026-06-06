import crypto from "node:crypto";
import {
  DocumentReference,
  FieldValue,
  Timestamp,
  Transaction,
} from "firebase-admin/firestore";

export type TicketBuyerSnapshot = {
  email?: string | null;
  displayName?: string | null;
  suburb?: string | null;
  email_opt_in?: boolean;
  sms_opt_in?: boolean;
  socials?: Record<string, string>;
};

export type TicketHolderInput = {
  holderName: string;
  holderEmail: string;
  holderPhone?: string | null;
  holderEmailOptIn?: boolean;
  holderSmsOptIn?: boolean;
};

export type NormalizedTicketHolderInput = TicketHolderInput & {
  holderEmailOptIn: boolean;
  holderSmsOptIn: boolean;
};

export type CreateCheckoutSessionInput = {
  showId: string;
  ticketTypeId: string;
  quantity: number;
  promoCode?: string;
  sellingFrontId?: string;
  buyerSnapshot?: TicketBuyerSnapshot;
  holders?: TicketHolderInput[];
  successUrl?: string;
  cancelUrl?: string;
};

export type NormalizedCheckoutInput = {
  showId: string;
  ticketTypeId: string;
  quantity: number;
  promoCode?: string;
  sellingFrontId?: string;
  buyerSnapshot: Required<
    Pick<TicketBuyerSnapshot, "email_opt_in" | "sms_opt_in" | "socials">
  > &
    Omit<TicketBuyerSnapshot, "email_opt_in" | "sms_opt_in" | "socials">;
  holders: NormalizedTicketHolderInput[];
  successUrl?: string;
  cancelUrl?: string;
};

export type TicketOrderData = {
  showId: string;
  sellingFrontId: string;
  buyerUid: string;
  buyerSnapshot: TicketBuyerSnapshot;
  status: string;
  lineItems: Array<{
    ticketTypeId: string;
    name: string;
    quantity: number;
    priceCents: number;
    bookingFeeCents: number;
    subtotalCents: number;
    bookingFeeTotalCents: number;
    discountCents?: number;
    totalCents: number;
  }>;
  holders?: TicketHolderInput[];
  stripeCheckoutSessionId?: string | null;
  stripeCheckoutSessionUrl?: string | null;
  stripePaymentIntentId?: string | null;
  subtotalCents: number;
  bookingFeeCents: number;
  discountCents?: number;
  promoCode?: {
    id: string;
    code: string;
    discountType: PromoCodeData["discountType"];
    percentOff?: number | null;
    amountOffCents?: number | null;
    discountCents: number;
  } | null;
  stripeFeeCents?: number | null;
  totalCents: number;
  currency: string;
  reservationExpiresAt?: Timestamp | null;
  createdAt?: Timestamp | FieldValue;
  updatedAt?: Timestamp | FieldValue;
  paidAt?: Timestamp | FieldValue | null;
};

export type TicketTypeData = {
  name: string;
  description?: string;
  priceCents: number;
  bookingFeeCents: number;
  currency: string;
  quantityTotal: number;
  quantitySold: number;
  quantityReserved: number;
  saleStartAt: Timestamp;
  saleEndAt: Timestamp;
  maxPerOrder: number;
  active: boolean;
  displayOrder?: number;
};

export type TicketedShowData = {
  orgId?: string;
  title: string;
  sellingFrontId: string;
  startDate: Timestamp;
  venueId: string;
  status: string;
  capacity: number;
  ticketingEnabled: boolean;
  currency: string;
};

export type PromoCodeData = {
  code: string;
  active: boolean;
  discountType: "percent" | "amount";
  percentOff?: number | null;
  amountOffCents?: number | null;
  validFrom?: Timestamp | null;
  validUntil?: Timestamp | null;
  maxRedemptions?: number | null;
  redemptionCount?: number;
  reservationCount?: number;
  ticketTypeIds?: string[];
  minQuantity?: number | null;
};

export type PromoCodePricing = {
  promoCodeId: string;
  code: string;
  discountType: PromoCodeData["discountType"];
  percentOff?: number | null;
  amountOffCents?: number | null;
  discountCents: number;
  subtotalAfterDiscountCents: number;
};

export type ReleaseResult = {
  released: boolean;
  quantityReleased: number;
  reason: string;
};

export const CHECKOUT_RESERVATION_MINUTES = 31;
export const PUBLIC_SHOW_STATUSES = new Set(["published", "on_sale"]);

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function cents(
  quantity: number,
  priceCents: number,
  bookingFeeCents: number,
) {
  return {
    subtotalCents: quantity * priceCents,
    bookingFeeCents: quantity * bookingFeeCents,
    totalCents: quantity * (priceCents + bookingFeeCents),
  };
}

export function normalisePromoCode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code)) {
    return null;
  }
  return code;
}

export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : null;
}

export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function timestampMillis(value: unknown): number {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "object" && value !== null && "seconds" in value) {
    const seconds = Number((value as { seconds: unknown }).seconds);
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  }
  return 0;
}

export function createReservationExpiry(): Timestamp {
  return Timestamp.fromMillis(
    Date.now() + CHECKOUT_RESERVATION_MINUTES * 60 * 1000,
  );
}

export function calculatePromoDiscount(params: {
  promoCodeId: string;
  promo: PromoCodeData;
  quantity: number;
  ticketTypeId: string;
  subtotalCents: number;
  nowMillis?: number;
}): PromoCodePricing {
  const nowMillis = params.nowMillis ?? Date.now();
  if (!params.promo.active) {
    throw new Error("Promo code is not active.");
  }
  if (timestampMillis(params.promo.validFrom) > nowMillis) {
    throw new Error("Promo code is not valid yet.");
  }
  const validUntilMillis = timestampMillis(params.promo.validUntil);
  if (validUntilMillis > 0 && validUntilMillis < nowMillis) {
    throw new Error("Promo code has expired.");
  }
  const ticketTypeIds = Array.isArray(params.promo.ticketTypeIds)
    ? params.promo.ticketTypeIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : [];
  if (
    ticketTypeIds.length > 0 &&
    !ticketTypeIds.includes(params.ticketTypeId)
  ) {
    throw new Error("Promo code is not valid for this ticket type.");
  }
  const minQuantity = Number(params.promo.minQuantity ?? 0);
  if (
    Number.isFinite(minQuantity) &&
    minQuantity > 0 &&
    params.quantity < minQuantity
  ) {
    throw new Error(`Promo code requires at least ${minQuantity} tickets.`);
  }
  const maxRedemptions = Number(params.promo.maxRedemptions ?? 0);
  if (Number.isFinite(maxRedemptions) && maxRedemptions > 0) {
    const committed =
      Number(params.promo.redemptionCount ?? 0) +
      Number(params.promo.reservationCount ?? 0);
    if (committed >= maxRedemptions) {
      throw new Error("Promo code has reached its usage limit.");
    }
  }

  let rawDiscountCents = 0;
  if (params.promo.discountType === "percent") {
    const percentOff = Number(params.promo.percentOff ?? 0);
    if (!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 100) {
      throw new Error("Promo code percentage is invalid.");
    }
    rawDiscountCents = Math.round(params.subtotalCents * (percentOff / 100));
  } else if (params.promo.discountType === "amount") {
    const amountOffCents = Number(params.promo.amountOffCents ?? 0);
    if (!Number.isFinite(amountOffCents) || amountOffCents <= 0) {
      throw new Error("Promo code amount is invalid.");
    }
    rawDiscountCents = Math.round(amountOffCents);
  } else {
    throw new Error("Promo code discount type is invalid.");
  }

  const discountCents = Math.min(
    params.subtotalCents,
    Math.max(0, rawDiscountCents),
  );
  if (discountCents <= 0) {
    throw new Error("Promo code does not discount this order.");
  }

  return {
    promoCodeId: params.promoCodeId,
    code: params.promo.code || params.promoCodeId,
    discountType: params.promo.discountType,
    percentOff: params.promo.percentOff ?? null,
    amountOffCents: params.promo.amountOffCents ?? null,
    discountCents,
    subtotalAfterDiscountCents: params.subtotalCents - discountCents,
  };
}

export function generateQrToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashQrToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function releaseOrderReservation(
  tx: Transaction,
  orderRef: DocumentReference,
  order: TicketOrderData,
  ticketTypeRef: DocumentReference,
  ticketType: TicketTypeData,
  nextStatus: "cancelled" | "paid" = "cancelled",
): ReleaseResult {
  if (order.status !== "pending") {
    return {
      released: false,
      quantityReleased: 0,
      reason: `order status is ${order.status}`,
    };
  }

  const lineItem = order.lineItems[0];
  const quantity = lineItem?.quantity ?? 0;
  const quantityReserved = Number(ticketType.quantityReserved ?? 0);
  const quantityReleased = Math.min(quantityReserved, quantity);

  tx.update(ticketTypeRef, {
    quantityReserved: quantityReserved - quantityReleased,
    updatedAt: FieldValue.serverTimestamp(),
  });
  tx.update(orderRef, {
    status: nextStatus,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    released: quantityReleased > 0,
    quantityReleased,
    reason: "reservation released",
  };
}
