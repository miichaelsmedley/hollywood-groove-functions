import admin from "firebase-admin";
import { createHash } from "node:crypto";

const hashEmail = (value) =>
  createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "theta-inkwell-448908-g9";
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST;
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_EMULATOR_HOST;
process.env.HG_TICKETING_DATABASE_ID = "(default)";
process.env.HG_STRIPE_MOCK_CHECKOUT = "true";
process.env.HG_CHECKOUT_BASE_URL = "http://localhost:5173";

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID });
}

const checkoutModule = await import("../lib/createCheckoutSession.js");
const webhookModule = await import("../lib/stripeWebhook.js");
const reservationsModule = await import("../lib/expireReservations.js");
const refundModule = await import("../lib/refundOrder.js");

const {
  createCheckoutSessionForAuthenticatedUser,
} = checkoutModule.default ?? checkoutModule;
const {
  buildCheckoutCompletedEvent,
  processStripeEvent,
} = webhookModule.default ?? webhookModule;
const {
  expirePendingReservations,
} = reservationsModule.default ?? reservationsModule;
const {
  refundPaidOrderAsAdmin,
} = refundModule.default ?? refundModule;

const db = admin.firestore();
const auth = admin.auth();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const ids = {
  front: "hollywood_groove",
  venue: "phase2_emulator_venue",
  show: "phase2_hg_show",
  ticketType: "general_admission",
  buyerUid: "phase2_buyer",
  adminUid: "phase2_admin",
};

const SHOW_TITLE = "Hollywood Groove Phase 2 Stripe Test";

function futureDate(minutes) {
  return Timestamp.fromDate(new Date(Date.now() + minutes * 60 * 1000));
}

async function deleteDocTree(ref) {
  const subcollections = await ref.listCollections();
  for (const subcollection of subcollections) {
    const docs = await subcollection.listDocuments();
    for (const doc of docs) {
      await deleteDocTree(doc);
    }
  }
  await ref.delete();
}

async function cleanQuery(query) {
  const snap = await query.get();
  for (const doc of snap.docs) {
    await deleteDocTree(doc.ref);
  }
}

async function cleanPhase2Data() {
  await deleteDocTree(db.collection("venues").doc(ids.venue));
  await deleteDocTree(db.collection("shows").doc(ids.show));
  await cleanQuery(db.collection("orders").where("showId", "==", ids.show));
  await cleanQuery(db.collection("tickets").where("showId", "==", ids.show));
  await cleanQuery(db.collection("auditLog").where("targetId", "==", ids.show));
  await cleanQuery(db.collection("refunds").where("initiatedByUid", "==", ids.adminUid));
}

async function seedUser() {
  try {
    await auth.createUser({
      uid: ids.buyerUid,
      email: "phase2-buyer@example.invalid",
      emailVerified: true,
      displayName: "Phase 2 Buyer",
    });
  } catch (error) {
    if (error.code !== "auth/uid-already-exists") {
      throw error;
    }
    await auth.updateUser(ids.buyerUid, {
      email: "phase2-buyer@example.invalid",
      emailVerified: true,
      displayName: "Phase 2 Buyer",
    });
  }
}

async function seedTicketingConfig() {
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();

  batch.set(db.collection("sellingFronts").doc(ids.front), {
    displayName: "Hollywood Groove",
    slug: "hollywood-groove",
    active: true,
    displayOrder: 1,
    defaultCurrency: "AUD",
    publicSiteUrl: "https://app.hollywoodgroove.com.au",
    supportEmail: "miichael.smedley@gmail.com",
    merchantOfRecord: "hollywood_groove",
    createdAt: now,
    updatedAt: now,
  }, { merge: true });

  batch.set(db.collection("venues").doc(ids.venue), {
    name: "Phase 2 Emulator Venue",
    address: "Sydney, NSW",
    capacity: 60,
    public: true,
    stripeConnectAccountId: null,
    createdAt: now,
    updatedAt: now,
  });

  batch.set(db.collection("shows").doc(ids.show), {
    title: SHOW_TITLE,
    sellingFrontId: ids.front,
    startDate: futureDate(60 * 24 * 30),
    venueId: ids.venue,
    status: "on_sale",
    capacity: 60,
    ticketingEnabled: true,
    currency: "AUD",
    refundPolicy: { mode: "default", cutoffHours: 24, allowAfterScan: false },
    rtdbShowId: "phase2",
    eventAdminUids: [],
    createdBy: "phase2_seed",
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
  });

  batch.set(db.collection("shows").doc(ids.show).collection("ticketTypes").doc(ids.ticketType), {
    name: "General Admission",
    description: "Phase 2 Stripe emulator GA ticket",
    priceCents: 3000,
    bookingFeeCents: 250,
    currency: "AUD",
    quantityTotal: 3,
    quantitySold: 0,
    quantityReserved: 0,
    saleStartAt: futureDate(-60),
    saleEndAt: futureDate(60 * 24 * 20),
    maxPerOrder: 3,
    active: true,
    displayOrder: 1,
    createdAt: now,
    updatedAt: now,
  });

  await batch.commit();
}

async function createCheckout(quantity, holderEmailSuffix = "buyer", sellingFrontId = ids.front) {
  return createCheckoutSessionForAuthenticatedUser({
    buyer: {
      uid: ids.buyerUid,
      email: "phase2-buyer@example.invalid",
      displayName: "Phase 2 Buyer",
      emailVerified: true,
    },
    data: {
      showId: ids.show,
      ticketTypeId: ids.ticketType,
      quantity,
      sellingFrontId,
      buyerSnapshot: {
        email: "phase2-buyer@example.invalid",
        displayName: "Phase 2 Buyer",
        suburb: "Point Cook",
        email_opt_in: true,
        sms_opt_in: false,
        socials: {},
      },
      holders: Array.from({ length: quantity }, (_, index) => ({
        holderName: index === 0 ? "Phase 2 Buyer" : `Phase 2 Friend ${index + 1}`,
        holderEmail: index === 0
          ? "phase2-buyer@example.invalid"
          : `phase2-${holderEmailSuffix}-${index + 1}@example.invalid`,
        holderPhone: null,
        holderEmailOptIn: index === 0,
        holderSmsOptIn: false,
      })),
      successUrl: "http://localhost:5173/tickets/success",
      cancelUrl: "http://localhost:5173/tickets/cancelled",
    },
  });
}

async function assertSellingFrontMismatchRejected() {
  try {
    await createCheckout(1, "wrong-front", "adele_show");
    throw new Error("expected sellingFrontId mismatch to be rejected");
  } catch (error) {
    if (error?.code !== "failed-precondition") {
      throw error;
    }
  }
  await assertTicketType(0, 0);
}

async function assertTicketType(expectedSold, expectedReserved) {
  const snap = await db.collection("shows").doc(ids.show).collection("ticketTypes").doc(ids.ticketType).get();
  const data = snap.data();
  if (data.quantitySold !== expectedSold || data.quantityReserved !== expectedReserved) {
    throw new Error(`unexpected inventory: sold=${data.quantitySold}, reserved=${data.quantityReserved}`);
  }
}

async function assertOrderStatus(orderId, expectedStatus) {
  const snap = await db.collection("orders").doc(orderId).get();
  const data = snap.data();
  if (data.status !== expectedStatus) {
    throw new Error(`unexpected order ${orderId} status: ${data.status}`);
  }
  return data;
}

async function assertTicketCount(orderId, expectedCount) {
  const snap = await db.collection("tickets").where("orderId", "==", orderId).get();
  if (snap.size !== expectedCount) {
    throw new Error(`expected ${expectedCount} tickets for ${orderId}, got ${snap.size}`);
  }
  for (const doc of snap.docs) {
    const ticket = doc.data();
    if (!ticket.qrToken || !ticket.qrTokenHash || ticket.status !== "valid") {
      throw new Error(`invalid ticket payload: ${JSON.stringify(ticket)}`);
    }
    if (ticket.showTitle !== SHOW_TITLE) {
      throw new Error(
        `expected ticket ${doc.id} showTitle ${JSON.stringify(SHOW_TITLE)}, got ${JSON.stringify(ticket.showTitle)}`,
      );
    }
    if (!ticket.showStartDate) {
      throw new Error(
        `expected ticket ${doc.id} to carry showStartDate, got ${JSON.stringify(ticket.showStartDate)}`,
      );
    }
  }
}

async function assertTicketStatus(orderId, expectedStatus) {
  const snap = await db.collection("tickets").where("orderId", "==", orderId).get();
  if (snap.empty) {
    throw new Error(`expected tickets for ${orderId}`);
  }
  for (const doc of snap.docs) {
    const ticket = doc.data();
    if (ticket.status !== expectedStatus) {
      throw new Error(`expected ticket ${doc.id} to be ${expectedStatus}, got ${ticket.status}`);
    }
  }
}

async function assertRefundCount(orderId, expectedCount) {
  const snap = await db.collection("refunds").where("orderId", "==", orderId).get();
  if (snap.size !== expectedCount) {
    throw new Error(`expected ${expectedCount} refund docs for ${orderId}, got ${snap.size}`);
  }
}

// Verified buyer's own ticket binds to their account (no claim record); any
// other-email holder is left unbound and claimable by email via ticketShareClaims.
async function assertTicketBinding(orderId) {
  const snap = await db.collection("tickets").where("orderId", "==", orderId).get();
  let bound = 0;
  let claimable = 0;
  for (const docSnap of snap.docs) {
    const t = docSnap.data();
    const claim = await db.collection("ticketShareClaims").doc(docSnap.id).get();
    const isBuyerEmail =
      String(t.holderEmail || "").trim().toLowerCase() === "phase2-buyer@example.invalid";
    if (isBuyerEmail) {
      if (t.holderMemberUid !== ids.buyerUid) {
        throw new Error(`verified buyer ticket ${docSnap.id} should bind to buyerUid, got ${t.holderMemberUid}`);
      }
      if (claim.exists) {
        throw new Error(`verified buyer ticket ${docSnap.id} should have no claim record`);
      }
      bound += 1;
    } else {
      if (t.holderMemberUid) {
        throw new Error(`other-email ticket ${docSnap.id} should be unbound, got ${t.holderMemberUid}`);
      }
      if (!claim.exists) {
        throw new Error(`other-email ticket ${docSnap.id} should have a ticketShareClaims record`);
      }
      if (claim.data().emailHash !== hashEmail(t.holderEmail)) {
        throw new Error(`claim emailHash mismatch for ticket ${docSnap.id}`);
      }
      claimable += 1;
    }
  }
  if (bound !== 1 || claimable !== 1) {
    throw new Error(`expected 1 bound + 1 claimable ticket, got bound=${bound} claimable=${claimable}`);
  }
}

async function main() {
  console.log("PHASE2_STRIPE_EMULATOR_START");
  await cleanPhase2Data();
  await seedUser();
  await seedTicketingConfig();

  await assertSellingFrontMismatchRejected();

  const checkout = await createCheckout(1);
  await assertOrderStatus(checkout.orderId, "pending");
  await assertTicketType(0, 1);

  const event = buildCheckoutCompletedEvent({
    eventId: "evt_phase2_completed",
    orderId: checkout.orderId,
    sessionId: checkout.checkoutSessionId,
    paymentIntentId: "pi_phase2_completed",
  });

  const processed = await processStripeEvent(event);
  if (processed.status !== "processed") {
    throw new Error(`expected processed webhook, got ${processed.status}`);
  }
  await processStripeEvent(event);
  await processStripeEvent(event);

  await assertOrderStatus(checkout.orderId, "paid");
  await assertTicketType(1, 0);
  await assertTicketCount(checkout.orderId, 1);

  const refund = await refundPaidOrderAsAdmin({
    actorUid: ids.adminUid,
    data: {
      orderId: checkout.orderId,
      reason: "Phase 2 emulator full refund",
      stripeReason: "requested_by_customer",
      forceAfterScan: false,
    },
  });
  if (refund.status !== "succeeded") {
    throw new Error(`expected succeeded refund, got ${refund.status}`);
  }
  await assertOrderStatus(checkout.orderId, "refunded");
  await assertTicketType(0, 0);
  await assertTicketStatus(checkout.orderId, "refunded");
  await assertRefundCount(checkout.orderId, 1);

  const abandoned = await createCheckout(2, "abandoned");
  await assertOrderStatus(abandoned.orderId, "pending");
  await assertTicketType(0, 2);
  await db.collection("orders").doc(abandoned.orderId).update({
    reservationExpiresAt: Timestamp.fromMillis(Date.now() - 60 * 1000),
  });
  const expiry = await expirePendingReservations();
  if (expiry.expired !== 1) {
    throw new Error(`expected 1 expired reservation, got ${JSON.stringify(expiry)}`);
  }
  await assertOrderStatus(abandoned.orderId, "cancelled");
  await assertTicketType(0, 0);

  // Guest/friend claimability: a paid 2-ticket order binds the VERIFIED buyer's
  // own ticket to their account and leaves the friend ticket (different email)
  // claimable by email via a ticketShareClaims record (the guest-checkout path).
  const claimOrder = await createCheckout(2, "claimtest");
  const claimEvent = buildCheckoutCompletedEvent({
    eventId: "evt_phase2_claimable",
    orderId: claimOrder.orderId,
    sessionId: claimOrder.checkoutSessionId,
    paymentIntentId: "pi_phase2_claimable",
  });
  const claimProcessed = await processStripeEvent(claimEvent);
  if (claimProcessed.status !== "processed") {
    throw new Error(`expected processed claimable webhook, got ${claimProcessed.status}`);
  }
  await assertOrderStatus(claimOrder.orderId, "paid");
  await assertTicketCount(claimOrder.orderId, 2);
  await assertTicketBinding(claimOrder.orderId);

  console.log(JSON.stringify({
    ok: true,
    projectId: PROJECT_ID,
    firestoreEmulator: FIRESTORE_EMULATOR_HOST,
    authEmulator: AUTH_EMULATOR_HOST,
    checkout: {
      orderStatus: "paid",
      ticketCount: 1,
      webhookReplaySafe: true,
    },
    refund: {
      orderStatus: "refunded",
      ticketStatus: "refunded",
      inventoryReturned: true,
    },
    reservationExpiry: expiry,
  }, null, 2));
  console.log("PHASE2_STRIPE_EMULATOR_OK");
}

main().catch((error) => {
  console.error("PHASE2_STRIPE_EMULATOR_FAILED");
  console.error(error);
  process.exit(1);
});
