// Phase 2 sandbox verifier.
//
// Run after the user has completed payment via Stripe test card 4242 4242 4242 4242.
// Checks:
//   - orders/{orderId}.status flipped from "pending" to "paid"
//   - stripePaymentIntentId is set
//   - shows/{showId}/ticketTypes/{ticketTypeId} has quantitySold incremented + quantityReserved decremented
//   - At least one tickets/* doc exists for the order with a qrTokenHash
//   - stripeEvents/{eventId} exists for the checkout.session.completed event
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=/Users/michaelsmedley/HollywoodGroove/theta-inkwell-448908-g9-firebase-adminsdk-fbsvc-a0d39286f8.json \
//     node scripts/phase2-sandbox-verify.mjs <orderId>

import admin from "firebase-admin";

const PROJECT_ID = process.env.GCLOUD_PROJECT || "theta-inkwell-448908-g9";
const DATABASE_ID = "ticketing";

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID });
}

const db = admin.firestore();
db.settings({ databaseId: DATABASE_ID });

const orderId = process.argv[2];
if (!orderId) {
  console.error("Usage: node scripts/phase2-sandbox-verify.mjs <orderId>");
  process.exit(2);
}

function maskQrHash(hash) {
  if (typeof hash !== "string" || hash.length < 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

async function main() {
  console.log(`Verifying order ${orderId} in '${DATABASE_ID}' (project ${PROJECT_ID})`);

  const orderSnap = await db.collection("orders").doc(orderId).get();
  if (!orderSnap.exists) {
    console.error("FAIL: order not found");
    process.exit(1);
  }
  const order = orderSnap.data();
  const checks = [];

  checks.push({
    name: "order.status == paid",
    pass: order.status === "paid",
    actual: order.status,
  });
  checks.push({
    name: "order.stripePaymentIntentId present",
    pass: typeof order.stripePaymentIntentId === "string" && order.stripePaymentIntentId.length > 0,
    actual: order.stripePaymentIntentId,
  });
  checks.push({
    name: "order.stripeCheckoutSessionId present",
    pass: typeof order.stripeCheckoutSessionId === "string" && order.stripeCheckoutSessionId.length > 0,
    actual: order.stripeCheckoutSessionId,
  });

  const ticketTypeSnap = await db
    .collection("shows").doc(order.showId)
    .collection("ticketTypes").doc(order.lineItems[0].ticketTypeId)
    .get();
  if (!ticketTypeSnap.exists) {
    console.error("FAIL: ticket type not found");
    process.exit(1);
  }
  const ticketType = ticketTypeSnap.data();
  checks.push({
    name: "ticketType.quantitySold >= order quantity",
    pass: (ticketType.quantitySold ?? 0) >= order.lineItems[0].quantity,
    actual: { quantitySold: ticketType.quantitySold, quantityReserved: ticketType.quantityReserved },
  });

  const ticketsSnap = await db.collection("tickets").where("orderId", "==", orderId).get();
  const ticketRows = ticketsSnap.docs.map((d) => {
    const t = d.data();
    return {
      id: d.id,
      status: t.status,
      qrTokenHash: maskQrHash(t.qrTokenHash),
      holderName: t.holderName,
      holderEmail: t.holderEmail,
    };
  });
  checks.push({
    name: "tickets minted for this order",
    pass: ticketsSnap.size >= order.lineItems[0].quantity,
    actual: { count: ticketsSnap.size, tickets: ticketRows },
  });
  if (ticketsSnap.size > 0) {
    const first = ticketsSnap.docs[0].data();
    checks.push({
      name: "tickets[].qrTokenHash is 64-hex (SHA-256)",
      pass: typeof first.qrTokenHash === "string" && /^[0-9a-f]{64}$/.test(first.qrTokenHash),
      actual: maskQrHash(first.qrTokenHash),
    });
  }

  const stripeEventsSnap = await db
    .collection("stripeEvents")
    .where("relatedOrderId", "==", orderId)
    .get();
  const eventRows = stripeEventsSnap.docs.map((d) => ({
    id: d.id,
    type: d.data().type,
    status: d.data().status,
  }));
  checks.push({
    name: "stripeEvents recorded for this order",
    pass: stripeEventsSnap.size >= 1,
    actual: { count: stripeEventsSnap.size, events: eventRows },
  });
  if (stripeEventsSnap.size >= 1) {
    const completed = stripeEventsSnap.docs.find((d) => d.data().type === "checkout.session.completed");
    checks.push({
      name: "checkout.session.completed handled successfully",
      // Webhook writes status="processed" on the happy path and status="duplicate"
      // on idempotent replays. Either counts as a successful signature-verify + handle.
      pass: Boolean(completed) && ["processed", "duplicate"].includes(completed.data().status),
      actual: completed ? { id: completed.id, status: completed.data().status } : null,
    });
  }

  const allPass = checks.every((c) => c.pass);
  console.log("");
  console.log(JSON.stringify({ ok: allPass, orderId, checks }, null, 2));
  console.log("");
  console.log(allPass ? "VERIFY_OK" : "VERIFY_FAIL");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("VERIFY_FAIL", err);
  process.exit(1);
});
