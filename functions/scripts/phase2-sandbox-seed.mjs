// Phase 2 sandbox seed.
//
// Seeds a clearly-tagged sandbox show + ticket type + pending order in the
// production `ticketing` named Firestore database, then prints the Stripe
// Workbench Shell command to create a real Stripe-hosted Checkout Session
// pointing at this order. The deployed stripeWebhook then exercises the full
// signature-verification + ticket-issuance path with a real signed event.
//
// Run from the functions directory:
//   GOOGLE_APPLICATION_CREDENTIALS=/Users/michaelsmedley/HollywoodGroove/theta-inkwell-448908-g9-firebase-adminsdk-fbsvc-a0d39286f8.json \
//     node scripts/phase2-sandbox-seed.mjs
//
// After the user completes payment in the browser, run scripts/phase2-sandbox-verify.mjs
// to confirm the webhook minted tickets and the ledger flipped to "paid".

import admin from "firebase-admin";

const PROJECT_ID = process.env.GCLOUD_PROJECT || "theta-inkwell-448908-g9";
const DATABASE_ID = "ticketing"; // named DB in Sydney; NOT (default)
const RTDB_URL = "https://theta-inkwell-448908-g9-default-rtdb.asia-southeast1.firebasedatabase.app";

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: PROJECT_ID,
    databaseURL: RTDB_URL,
  });
}

const db = admin.firestore();
db.settings({ databaseId: DATABASE_ID });
const rtdb = admin.database();

const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const ids = {
  sellingFront: "adele_show", // Adele Show is merchant of record (ABN + .com.au)
  venue: "phase2_sandbox_venue",
  show: "phase2_sandbox_show",
  ticketType: "phase2_ga",
  buyerUid: "phase2_sandbox_buyer",
  // orderId is generated server-style so the webhook lookup matches
};

const ticketPriceCents = 100; // A$1.00
const bookingFeeCents = 50;   // A$0.50
const quantity = 1;
const subtotalCents = quantity * ticketPriceCents;
const bookingFeeTotalCents = quantity * bookingFeeCents;
const totalCents = subtotalCents + bookingFeeTotalCents;

async function seedSellingFrontIfMissing() {
  const ref = db.collection("sellingFronts").doc(ids.sellingFront);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      name: "The Adele Show",
      brand: "adele_show",
      legalEntity: "The Adele Show",
      merchantOfRecord: true,
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log(`Created sellingFronts/${ids.sellingFront}`);
  } else {
    console.log(`sellingFronts/${ids.sellingFront} already exists`);
  }
}

async function seedVenue() {
  const ref = db.collection("venues").doc(ids.venue);
  await ref.set({
    name: "SANDBOX Venue",
    address: "Test only — Phase 2 verification",
    sellingFrontId: ids.sellingFront,
    capacity: 100,
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`Upserted venues/${ids.venue}`);
}

async function seedShow() {
  const ref = db.collection("shows").doc(ids.show);
  const startDate = Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days out
  await ref.set({
    title: "SANDBOX - Phase 2 verification - DO NOT LIST",
    sellingFrontId: ids.sellingFront,
    startDate,
    venueId: ids.venue,
    status: "on_sale",
    capacity: 5,
    ticketingEnabled: true,
    currency: "AUD",
    refundPolicy: { mode: "default", cutoffHours: 24, allowAfterScan: false },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`Upserted shows/${ids.show}`);
}

async function seedRtdbShowMeta() {
  // ShowDetail reads RTDB shows/{showId}/meta for the existing engagement UI.
  // Mirror enough metadata here so /shows/<sandbox-id> renders end-to-end and
  // the buyer can see the show context above the TicketPurchasePanel.
  const startDateIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await rtdb.ref(`shows/${ids.show}/meta`).update({
    title: "SANDBOX - Phase 2 verification - DO NOT LIST",
    startDate: startDateIso,
    venueName: "SANDBOX Venue (test only)",
    schemaVersion: 1,
    publishedAt: Date.now(),
    isTestShow: true,
  });
  console.log(`Upserted RTDB shows/${ids.show}/meta`);
}

async function seedTicketType() {
  const ref = db.collection("shows").doc(ids.show).collection("ticketTypes").doc(ids.ticketType);
  const saleStartAt = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000); // 1h ago
  const saleEndAt = Timestamp.fromMillis(Date.now() + 29 * 24 * 60 * 60 * 1000); // 29 days out
  await ref.set({
    name: "Sandbox GA",
    description: "$1 test ticket for Phase 2 sandbox verification",
    priceCents: ticketPriceCents,
    bookingFeeCents,
    currency: "AUD",
    quantityTotal: 5,
    quantitySold: 0,
    quantityReserved: quantity, // reserved by the pending order we're about to seed
    saleStartAt,
    saleEndAt,
    maxPerOrder: 4,
    active: true,
    displayOrder: 1,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`Upserted shows/${ids.show}/ticketTypes/${ids.ticketType}`);
}

async function seedPendingOrder() {
  // Use a fixed order id so the verify script can find it again.
  const orderId = `phase2_sandbox_order_${Date.now()}`;
  const orderRef = db.collection("orders").doc(orderId);
  // 24h reservation for sandbox testing so it doesn't time-out between
  // seed and payment; production createCheckoutSession uses the standard
  // 31-minute window from shared.ts.
  const reservationExpiresAt = Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);
  await orderRef.set({
    showId: ids.show,
    sellingFrontId: ids.sellingFront,
    buyerUid: ids.buyerUid,
    buyerSnapshot: {
      email: "phase2-sandbox-buyer@example.invalid",
      displayName: "Phase 2 Sandbox Buyer",
      suburb: null,
      email_opt_in: false,
      sms_opt_in: false,
      socials: {},
    },
    status: "pending",
    lineItems: [
      {
        ticketTypeId: ids.ticketType,
        name: "Sandbox GA",
        quantity,
        priceCents: ticketPriceCents,
        bookingFeeCents,
        subtotalCents,
        bookingFeeTotalCents,
        totalCents,
      },
    ],
    holders: [
      {
        holderName: "Phase 2 Sandbox Buyer",
        holderEmail: "phase2-sandbox-buyer@example.invalid",
        holderPhone: null,
        holderEmailOptIn: false,
        holderSmsOptIn: false,
      },
    ],
    subtotalCents,
    bookingFeeCents: bookingFeeTotalCents,
    totalCents,
    currency: "AUD",
    reservationExpiresAt,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.log(`Created orders/${orderId} (status=pending, reservationExpiresAt=${reservationExpiresAt.toDate().toISOString()})`);
  return orderId;
}

function buildStripeShellCommand(orderId) {
  const successUrl = "https://app.hollywoodgroove.com.au/tickets/success?session_id={CHECKOUT_SESSION_ID}";
  const cancelUrl = "https://app.hollywoodgroove.com.au/tickets/cancelled";
  // Stripe CLI uses snake_case keys via -d for the underlying API form data.
  // We keep --mode/--success-url/--cancel-url as typed flags; everything else
  // is -d "key=value" because nested arrays/objects only work via -d.
  return [
    "stripe checkout sessions create",
    `--mode=payment`,
    `--success-url="${successUrl}"`,
    `--cancel-url="${cancelUrl}"`,
    `-d "client_reference_id=${orderId}"`,
    `-d "customer_email=phase2-sandbox-buyer@example.invalid"`,
    `-d "line_items[0][quantity]=${quantity}"`,
    `-d "line_items[0][price_data][currency]=aud"`,
    `-d "line_items[0][price_data][unit_amount]=${ticketPriceCents}"`,
    `-d "line_items[0][price_data][product_data][name]=SANDBOX Show - Sandbox GA"`,
    `-d "line_items[1][quantity]=${quantity}"`,
    `-d "line_items[1][price_data][currency]=aud"`,
    `-d "line_items[1][price_data][unit_amount]=${bookingFeeCents}"`,
    `-d "line_items[1][price_data][product_data][name]=Booking fee"`,
    `-d "metadata[orderId]=${orderId}"`,
    `-d "metadata[showId]=${ids.show}"`,
    `-d "metadata[ticketTypeId]=${ids.ticketType}"`,
    `-d "metadata[buyerUid]=${ids.buyerUid}"`,
    `-d "metadata[sellingFrontId]=${ids.sellingFront}"`,
    `-d "metadata[quantity]=${quantity}"`,
    `-d "payment_intent_data[metadata][orderId]=${orderId}"`,
    `-d "payment_intent_data[metadata][showId]=${ids.show}"`,
    `-d "payment_intent_data[metadata][ticketTypeId]=${ids.ticketType}"`,
    `-d "payment_intent_data[metadata][buyerUid]=${ids.buyerUid}"`,
    `-d "payment_intent_data[metadata][sellingFrontId]=${ids.sellingFront}"`,
    `-d "payment_intent_data[metadata][quantity]=${quantity}"`,
  ].join(" ");
}

async function main() {
  console.log(`Targeting Firestore database '${DATABASE_ID}' in project '${PROJECT_ID}'`);
  await seedSellingFrontIfMissing();
  await seedVenue();
  await seedShow();
  await seedRtdbShowMeta();
  await seedTicketType();
  const orderId = await seedPendingOrder();
  const command = buildStripeShellCommand(orderId);
  console.log("");
  console.log("SEED_OK");
  console.log(JSON.stringify({
    projectId: PROJECT_ID,
    databaseId: DATABASE_ID,
    sellingFrontId: ids.sellingFront,
    showId: ids.show,
    ticketTypeId: ids.ticketType,
    orderId,
    buyerUid: ids.buyerUid,
    priceCents: ticketPriceCents,
    bookingFeeCents,
    totalCents,
  }, null, 2));
  console.log("");
  console.log("--- Paste this into Stripe Dashboard → Workbench → Shell ---");
  console.log(command);
  console.log("--- End ---");
}

main().catch((err) => {
  console.error("SEED_FAIL", err);
  process.exit(1);
});
