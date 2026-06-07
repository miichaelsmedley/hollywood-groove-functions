import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import {
  getCheckoutBaseUrl,
  getStripeClient,
  REGION,
  shouldUseMockStripeCheckout,
  STRIPE_SECRET_KEY,
  getTicketingDb,
} from "./ticketing/config";
import {
  asRecord,
  calculatePromoDiscount,
  cents,
  createReservationExpiry,
  CreateCheckoutSessionInput,
  NormalizedCheckoutInput,
  normalisePromoCode,
  nonEmptyString,
  normaliseEmail,
  PromoCodeData,
  PromoCodePricing,
  PUBLIC_SHOW_STATUSES,
  TicketedShowData,
  TicketHolderInput,
  TicketTypeData,
  timestampMillis,
} from "./ticketing/shared";

type AuthenticatedBuyer = {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  emailVerified?: boolean;
};

type CheckoutSessionResult = {
  orderId: string;
  checkoutSessionId: string;
  url: string;
  expiresAt: number;
};

type CheckoutTotals = {
  subtotalCents: number;
  bookingFeeCents: number;
  subtotalAfterDiscountCents: number;
  discountCents: number;
  totalCents: number;
};

function requireString(value: unknown, fieldName: string): string {
  const text = nonEmptyString(value);
  if (!text) {
    throw new HttpsError("invalid-argument", `${fieldName} is required.`);
  }
  return text;
}

function validateReturnUrl(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const text = requireString(value, fieldName);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} must be a valid URL.`,
    );
  }
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  ) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} must be HTTPS outside localhost.`,
    );
  }
  return url.toString();
}

function validateQuantity(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 20) {
    throw new HttpsError(
      "invalid-argument",
      "quantity must be an integer between 1 and 20.",
    );
  }
  return Number(value);
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeHolders(
  rawHolders: unknown,
  quantity: number,
  fallbackEmail: string,
  fallbackDisplayName?: string | null,
): Array<
  TicketHolderInput & { holderEmailOptIn: boolean; holderSmsOptIn: boolean }
> {
  const holders = Array.isArray(rawHolders) ? rawHolders.map(asRecord) : [];
  if (holders.length === 0) {
    return Array.from({ length: quantity }, (_, index) => ({
      holderName:
        fallbackDisplayName ||
        (index === 0 ? "Ticket Holder" : `Guest ${index + 1}`),
      holderEmail: fallbackEmail,
      holderPhone: null,
      holderEmailOptIn: false,
      holderSmsOptIn: false,
    }));
  }

  if (holders.length !== quantity) {
    throw new HttpsError(
      "invalid-argument",
      "holders length must match quantity.",
    );
  }

  return holders.map((holder, index) => {
    const holderEmail = normaliseEmail(holder.holderEmail);
    if (!holderEmail) {
      throw new HttpsError(
        "invalid-argument",
        `holders[${index}].holderEmail must be a valid email.`,
      );
    }

    return {
      holderName: nonEmptyString(holder.holderName) || `Guest ${index + 1}`,
      holderEmail,
      holderPhone: nonEmptyString(holder.holderPhone) || null,
      holderEmailOptIn: normalizeBoolean(holder.holderEmailOptIn),
      holderSmsOptIn: normalizeBoolean(holder.holderSmsOptIn),
    };
  });
}

function normalizeInput(
  data: unknown,
  buyer: AuthenticatedBuyer,
): NormalizedCheckoutInput {
  const record = asRecord(data);
  const buyerSnapshotRecord = asRecord(record.buyerSnapshot);
  const buyerEmail =
    normaliseEmail(buyerSnapshotRecord.email) || normaliseEmail(buyer.email);
  if (!buyerEmail) {
    throw new HttpsError(
      "invalid-argument",
      "buyerSnapshot.email is required for ticket delivery.",
    );
  }

  const quantity = validateQuantity(record.quantity);
  const displayName =
    nonEmptyString(buyerSnapshotRecord.displayName) ||
    buyer.displayName ||
    null;

  return {
    showId: requireString(record.showId, "showId"),
    ticketTypeId: requireString(record.ticketTypeId, "ticketTypeId"),
    quantity,
    promoCode: normalisePromoCode(record.promoCode) || undefined,
    sellingFrontId: nonEmptyString(record.sellingFrontId) || undefined,
    buyerSnapshot: {
      email: buyerEmail,
      displayName,
      suburb: nonEmptyString(buyerSnapshotRecord.suburb),
      email_opt_in: normalizeBoolean(buyerSnapshotRecord.email_opt_in),
      sms_opt_in: normalizeBoolean(buyerSnapshotRecord.sms_opt_in),
      socials: asRecord(buyerSnapshotRecord.socials) as Record<string, string>,
    },
    holders: normalizeHolders(
      record.holders,
      quantity,
      buyerEmail,
      displayName,
    ),
    successUrl: validateReturnUrl(record.successUrl, "successUrl"),
    cancelUrl: validateReturnUrl(record.cancelUrl, "cancelUrl"),
  };
}

function validateTicketSale(
  show: TicketedShowData,
  ticketType: TicketTypeData,
  quantity: number,
): void {
  if (!show.ticketingEnabled || !PUBLIC_SHOW_STATUSES.has(show.status)) {
    throw new HttpsError(
      "failed-precondition",
      "Tickets are not on sale for this show.",
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
  if (quantity > ticketType.maxPerOrder) {
    throw new HttpsError(
      "failed-precondition",
      `Maximum ${ticketType.maxPerOrder} tickets per order.`,
    );
  }

  const now = Date.now();
  if (
    timestampMillis(ticketType.saleStartAt) > now ||
    timestampMillis(ticketType.saleEndAt) < now
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Ticket sales are outside the sale window.",
    );
  }

  const available =
    ticketType.quantityTotal -
    ticketType.quantitySold -
    ticketType.quantityReserved;
  if (available < quantity) {
    throw new HttpsError(
      "failed-precondition",
      "Not enough tickets are available.",
    );
  }
}

function appendOrderId(url: string, orderId: string): string {
  if (/[?&]orderId=/.test(url)) {
    return url;
  }
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}orderId=${encodeURIComponent(orderId)}`;
}

function buildSuccessUrl(orderId: string, explicitUrl?: string): string {
  return appendOrderId(
    explicitUrl ||
      `${getCheckoutBaseUrl()}/tickets/success?session_id={CHECKOUT_SESSION_ID}`,
    orderId,
  );
}

function buildCancelUrl(orderId: string, explicitUrl?: string): string {
  return appendOrderId(
    explicitUrl || `${getCheckoutBaseUrl()}/tickets/cancelled`,
    orderId,
  );
}

async function createStripeCheckoutSession(params: {
  orderId: string;
  buyerUid: string;
  input: NormalizedCheckoutInput;
  show: TicketedShowData;
  ticketType: TicketTypeData;
  totals: CheckoutTotals;
  promo: PromoCodePricing | null;
}): Promise<{ id: string; url: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + 31 * 60;

  if (shouldUseMockStripeCheckout()) {
    return {
      id: `cs_test_mock_${params.orderId}`,
      url: `${getCheckoutBaseUrl()}/__mock_stripe_checkout/${params.orderId}`,
      expiresAt,
    };
  }

  const stripe = getStripeClient();
  const metadata: Record<string, string> = {
    orderId: params.orderId,
    showId: params.input.showId,
    ticketTypeId: params.input.ticketTypeId,
    buyerUid: params.buyerUid,
    sellingFrontId: params.show.sellingFrontId,
    quantity: String(params.input.quantity),
  };
  if (params.promo) {
    metadata.promoCodeId = params.promo.promoCodeId;
    metadata.promoCode = params.promo.code;
    metadata.discountCents = String(params.promo.discountCents);
  }

  const lineItems: Array<{
    quantity: number;
    price_data: {
      currency: "aud";
      product_data: {
        name: string;
        description?: string;
      };
      unit_amount: number;
    };
  }> = [];

  if (params.totals.discountCents > 0) {
    if (params.totals.subtotalAfterDiscountCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: "aud",
          product_data: {
            name: `${params.input.quantity} x ${params.show.title} - ${params.ticketType.name}`,
            description: `Includes promo ${params.promo?.code ?? "discount"}`,
          },
          unit_amount: params.totals.subtotalAfterDiscountCents,
        },
      });
    }
  } else {
    lineItems.push({
      quantity: params.input.quantity,
      price_data: {
        currency: "aud",
        product_data: {
          name: `${params.show.title} - ${params.ticketType.name}`,
          description: params.ticketType.description,
        },
        unit_amount: params.ticketType.priceCents,
      },
    });
  }

  if (params.ticketType.bookingFeeCents > 0) {
    lineItems.push({
      quantity: params.input.quantity,
      price_data: {
        currency: "aud",
        product_data: {
          name: "Booking fee",
          description: "Hollywood Groove ticketing platform fee",
        },
        unit_amount: params.ticketType.bookingFeeCents,
      },
    });
  }
  if (lineItems.length === 0 || params.totals.totalCents <= 0) {
    throw new Error("Stripe Checkout requires a payable order total.");
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: params.orderId,
    customer_email: params.input.buyerSnapshot.email ?? undefined,
    expires_at: expiresAt,
    line_items: lineItems,
    metadata,
    payment_intent_data: { metadata },
    success_url: buildSuccessUrl(params.orderId, params.input.successUrl),
    cancel_url: buildCancelUrl(params.orderId, params.input.cancelUrl),
  });

  if (!session.url) {
    throw new Error("Stripe did not return a Checkout URL.");
  }

  return {
    id: session.id,
    url: session.url,
    expiresAt: session.expires_at ?? expiresAt,
  };
}

async function cancelReservedOrder(params: {
  orderId: string;
  showId: string;
  ticketTypeId: string;
  quantity: number;
  promoCodeId?: string | null;
  reason: string;
}): Promise<void> {
  const db = getTicketingDb();
  const orderRef = db.collection("orders").doc(params.orderId);
  const ticketTypeRef = db
    .collection("shows")
    .doc(params.showId)
    .collection("ticketTypes")
    .doc(params.ticketTypeId);
  const promoRef = params.promoCodeId
    ? db
        .collection("shows")
        .doc(params.showId)
        .collection("promoCodes")
        .doc(params.promoCodeId)
    : null;

  await db.runTransaction(async (tx) => {
    const [orderSnap, ticketTypeSnap, promoSnap] = await Promise.all([
      tx.get(orderRef),
      tx.get(ticketTypeRef),
      promoRef ? tx.get(promoRef) : Promise.resolve(null),
    ]);
    if (!orderSnap.exists || !ticketTypeSnap.exists) {
      return;
    }
    const order = orderSnap.data();
    const ticketType = ticketTypeSnap.data();
    if (order?.status !== "pending") {
      return;
    }

    const reserved = Number(ticketType?.quantityReserved ?? 0);
    tx.update(ticketTypeRef, {
      quantityReserved: Math.max(0, reserved - params.quantity),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (promoRef && promoSnap?.exists) {
      const promo = promoSnap.data() as PromoCodeData;
      tx.update(promoRef, {
        reservationCount: Math.max(0, Number(promo.reservationCount ?? 0) - 1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(orderRef, {
      status: "cancelled",
      cancelledReason: params.reason,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

export async function createCheckoutSessionForAuthenticatedUser(params: {
  buyer: AuthenticatedBuyer;
  data: CreateCheckoutSessionInput | unknown;
}): Promise<CheckoutSessionResult> {
  const input = normalizeInput(params.data, params.buyer);
  const db = getTicketingDb();
  const orderRef = db.collection("orders").doc();
  const ticketTypeRef = db
    .collection("shows")
    .doc(input.showId)
    .collection("ticketTypes")
    .doc(input.ticketTypeId);
  const showRef = db.collection("shows").doc(input.showId);
  const promoRef = input.promoCode
    ? showRef.collection("promoCodes").doc(input.promoCode)
    : null;
  let showForStripe: TicketedShowData | null = null;
  let ticketTypeForStripe: TicketTypeData | null = null;
  let totalsForStripe: CheckoutTotals | null = null;
  let promoForStripe: PromoCodePricing | null = null;

  await db.runTransaction(async (tx) => {
    const [showSnap, ticketTypeSnap, promoSnap] = await Promise.all([
      tx.get(showRef),
      tx.get(ticketTypeRef),
      promoRef ? tx.get(promoRef) : Promise.resolve(null),
    ]);
    if (!showSnap.exists) {
      throw new HttpsError("not-found", "Show not found.");
    }
    if (!ticketTypeSnap.exists) {
      throw new HttpsError("not-found", "Ticket type not found.");
    }

    const show = showSnap.data() as TicketedShowData;
    const ticketType = ticketTypeSnap.data() as TicketTypeData;
    validateTicketSale(show, ticketType, input.quantity);
    if (input.sellingFrontId && input.sellingFrontId !== show.sellingFrontId) {
      throw new HttpsError(
        "failed-precondition",
        "This event is not available on that selling front.",
      );
    }

    const baseTotals = cents(
      input.quantity,
      ticketType.priceCents,
      ticketType.bookingFeeCents,
    );
    let promoPricing: PromoCodePricing | null = null;
    if (promoRef) {
      if (!promoSnap?.exists) {
        throw new HttpsError("not-found", "Promo code not found.");
      }
      try {
        promoPricing = calculatePromoDiscount({
          promoCodeId: promoRef.id,
          promo: promoSnap.data() as PromoCodeData,
          quantity: input.quantity,
          ticketTypeId: input.ticketTypeId,
          subtotalCents: baseTotals.subtotalCents,
        });
      } catch (error) {
        throw new HttpsError(
          "failed-precondition",
          error instanceof Error
            ? error.message
            : "Promo code is not valid for this order.",
        );
      }
    }
    const totals: CheckoutTotals = {
      ...baseTotals,
      discountCents: promoPricing?.discountCents ?? 0,
      subtotalAfterDiscountCents:
        promoPricing?.subtotalAfterDiscountCents ?? baseTotals.subtotalCents,
      totalCents:
        baseTotals.subtotalCents -
        (promoPricing?.discountCents ?? 0) +
        baseTotals.bookingFeeCents,
    };
    if (totals.totalCents <= 0) {
      throw new HttpsError(
        "failed-precondition",
        "Promo code reduces this order below the payable checkout total.",
      );
    }
    showForStripe = show;
    ticketTypeForStripe = ticketType;
    totalsForStripe = totals;
    promoForStripe = promoPricing;

    tx.update(ticketTypeRef, {
      quantityReserved: FieldValue.increment(input.quantity),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (promoRef && promoPricing) {
      tx.update(promoRef, {
        reservationCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.set(orderRef, {
      showId: input.showId,
      sellingFrontId: show.sellingFrontId,
      buyerUid: params.buyer.uid,
      buyerSnapshot: input.buyerSnapshot,
      buyerEmailVerified: params.buyer.emailVerified === true,
      status: "pending",
      lineItems: [
        {
          ticketTypeId: input.ticketTypeId,
          name: ticketType.name,
          quantity: input.quantity,
          priceCents: ticketType.priceCents,
          bookingFeeCents: ticketType.bookingFeeCents,
          subtotalCents: totals.subtotalCents,
          bookingFeeTotalCents: totals.bookingFeeCents,
          discountCents: totals.discountCents,
          totalCents: totals.totalCents,
        },
      ],
      holders: input.holders,
      stripeCheckoutSessionId: null,
      stripeCheckoutSessionUrl: null,
      stripePaymentIntentId: null,
      subtotalCents: totals.subtotalCents,
      bookingFeeCents: totals.bookingFeeCents,
      discountCents: totals.discountCents,
      promoCode: promoPricing
        ? {
            id: promoPricing.promoCodeId,
            code: promoPricing.code,
            discountType: promoPricing.discountType,
            percentOff: promoPricing.percentOff ?? null,
            amountOffCents: promoPricing.amountOffCents ?? null,
            discountCents: promoPricing.discountCents,
          }
        : null,
      stripeFeeCents: null,
      totalCents: totals.totalCents,
      currency: ticketType.currency,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      reservationExpiresAt: createReservationExpiry(),
      paidAt: null,
    });
  });

  try {
    if (!showForStripe || !ticketTypeForStripe || !totalsForStripe) {
      throw new Error("Ticketing data was not loaded for Stripe checkout.");
    }

    const stripePromo = promoForStripe as PromoCodePricing | null;
    const session = await createStripeCheckoutSession({
      orderId: orderRef.id,
      buyerUid: params.buyer.uid,
      input,
      show: showForStripe,
      ticketType: ticketTypeForStripe,
      totals: totalsForStripe,
      promo: stripePromo,
    });

    await orderRef.update({
      stripeCheckoutSessionId: session.id,
      stripeCheckoutSessionUrl: session.url,
      stripeCheckoutSessionExpiresAt: session.expiresAt,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info("Stripe Checkout Session created", {
      orderId: orderRef.id,
      showId: input.showId,
      ticketTypeId: input.ticketTypeId,
      quantity: input.quantity,
      promoCode: stripePromo?.code ?? null,
      discountCents: stripePromo?.discountCents ?? 0,
      mockStripe: shouldUseMockStripeCheckout(),
    });

    return {
      orderId: orderRef.id,
      checkoutSessionId: session.id,
      url: session.url,
      expiresAt: session.expiresAt,
    };
  } catch (error) {
    await cancelReservedOrder({
      orderId: orderRef.id,
      showId: input.showId,
      ticketTypeId: input.ticketTypeId,
      quantity: input.quantity,
      promoCodeId: input.promoCode,
      reason: error instanceof Error ? error.message : "stripe checkout failed",
    });
    logger.error("Stripe Checkout Session creation failed", {
      orderId: orderRef.id,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
      errorStack: error instanceof Error ? error.stack : undefined,
    });
    throw new HttpsError("internal", "Could not create checkout session.");
  }
}

export const createCheckoutSession = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
    secrets: [STRIPE_SECRET_KEY],
  },
  async (request) => {
    // Guest checkout: a signed-in account is NOT required to buy. We still
    // require Firebase Auth (anonymous is fine) + App Check + rate limiting for
    // abuse protection; the buyer's email comes from the checkout form. Buyers
    // sign in AFTER paying to claim their ticket (see claimMyPendingTickets).
    const authRequest = requireAuth(request, null, {
      keyPrefix: "createCheckoutSession",
      maxCalls: 10,
      windowMs: 60 * 1000,
    });

    return createCheckoutSessionForAuthenticatedUser({
      buyer: {
        uid: authRequest.auth.uid,
        email:
          typeof authRequest.auth.token.email === "string"
            ? authRequest.auth.token.email
            : null,
        displayName:
          typeof authRequest.auth.token.name === "string"
            ? authRequest.auth.token.name
            : null,
        emailVerified: authRequest.auth.token.email_verified === true,
      },
      data: request.data,
    });
  },
);
