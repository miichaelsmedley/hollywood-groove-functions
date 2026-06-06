import admin from "firebase-admin";
import crypto from "node:crypto";

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "theta-inkwell-448908-g9";
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const API_KEY = "phase1-ticketing-emulator";

process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST;
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_EMULATOR_HOST;

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID });
}

const db = admin.firestore();
const auth = admin.auth();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const ids = {
  fronts: ["hollywood_groove", "adele_show"],
  venue: "phase1_emulator_venue",
  staffUid: "phase1_staff",
  adminUid: "phase1_platform_admin",
  buyerUid: "phase1_buyer",
  otherUid: "phase1_other",
  shows: ["phase1_hg_show", "phase1_adele_show"],
  order: "phase1_order_hg_001",
  ticketOne: "phase1_ticket_hg_001",
  ticketTwo: "phase1_ticket_hg_002",
  refund: "phase1_refund_001",
  audit: "phase1_audit_seed",
};

function cents(quantity, priceCents, bookingFeeCents) {
  return {
    subtotalCents: quantity * priceCents,
    bookingFeeCents: quantity * bookingFeeCents,
    totalCents: quantity * (priceCents + bookingFeeCents),
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function futureDate(days) {
  return Timestamp.fromDate(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
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

async function cleanPhase1Data() {
  const refs = [
    ...ids.fronts.map((id) => db.collection("sellingFronts").doc(id)),
    db.collection("venues").doc(ids.venue),
    ...ids.shows.map((id) => db.collection("shows").doc(id)),
    db.collection("orders").doc(ids.order),
    db.collection("tickets").doc(ids.ticketOne),
    db.collection("tickets").doc(ids.ticketTwo),
    db.collection("refunds").doc(ids.refund),
    db.collection("auditLog").doc(ids.audit),
    db.collection("stripeEvents").doc("phase1_fake_event"),
  ];

  for (const ref of refs) {
    await deleteDocTree(ref);
  }
}

async function upsertUser(uid, email, claims = {}) {
  try {
    await auth.createUser({ uid, email, emailVerified: true });
  } catch (error) {
    if (error.code !== "auth/uid-already-exists") {
      throw error;
    }
    await auth.updateUser(uid, { email, emailVerified: true });
  }
  await auth.setCustomUserClaims(uid, claims);
}

async function seedUsers() {
  await upsertUser(ids.adminUid, "phase1-admin@example.invalid", { platform_admin: true });
  await upsertUser(ids.buyerUid, "phase1-buyer@example.invalid");
  await upsertUser(ids.otherUid, "phase1-other@example.invalid");
  await upsertUser(ids.staffUid, "phase1-staff@example.invalid", { door_staff: true });
}

async function seedTicketingConfig() {
  const batch = db.batch();
  const now = FieldValue.serverTimestamp();

  batch.set(db.collection("sellingFronts").doc("hollywood_groove"), {
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
  });

  batch.set(db.collection("sellingFronts").doc("adele_show"), {
    displayName: "The Adele Show",
    slug: "adele-show",
    active: true,
    displayOrder: 2,
    defaultCurrency: "AUD",
    publicSiteUrl: "https://adeleshow.com.au",
    supportEmail: "miichael.smedley@gmail.com",
    merchantOfRecord: "hollywood_groove",
    createdAt: now,
    updatedAt: now,
  });

  batch.set(db.collection("venues").doc(ids.venue), {
    name: "Phase 1 Emulator Venue",
    address: "Melbourne, VIC",
    capacity: 150,
    public: true,
    stripeConnectAccountId: null,
    createdAt: now,
    updatedAt: now,
  });

  batch.set(db.collection("venues").doc(ids.venue).collection("eligibleStaff").doc(ids.staffUid), {
    role: "door_staff",
    grantedBy: ids.adminUid,
    grantedAt: now,
  });

  batch.set(db.collection("shows").doc("phase1_hg_show"), {
    title: "Hollywood Groove Phase 1 Test Show",
    sellingFrontId: "hollywood_groove",
    startDate: futureDate(30),
    venueId: ids.venue,
    status: "on_sale",
    capacity: 120,
    ticketingEnabled: true,
    currency: "AUD",
    refundPolicy: { mode: "default", cutoffHours: 24, allowAfterScan: false },
    rtdbShowId: "101",
    eventAdminUids: [ids.adminUid],
    createdBy: ids.adminUid,
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
  });

  batch.set(db.collection("shows").doc("phase1_hg_show").collection("ticketTypes").doc("general_admission"), {
    name: "General Admission",
    description: "Phase 1 emulator GA ticket",
    priceCents: 2500,
    bookingFeeCents: 200,
    currency: "AUD",
    quantityTotal: 5,
    quantitySold: 0,
    quantityReserved: 0,
    saleStartAt: futureDate(-1),
    saleEndAt: futureDate(20),
    maxPerOrder: 4,
    active: true,
    displayOrder: 1,
    createdAt: now,
    updatedAt: now,
  });

  batch.set(db.collection("shows").doc("phase1_adele_show"), {
    title: "The Adele Show Phase 1 Test Show",
    sellingFrontId: "adele_show",
    startDate: futureDate(45),
    venueId: ids.venue,
    status: "on_sale",
    capacity: 180,
    ticketingEnabled: true,
    currency: "AUD",
    refundPolicy: { mode: "default", cutoffHours: 24, allowAfterScan: false },
    eventAdminUids: [ids.adminUid],
    createdBy: ids.adminUid,
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
  });

  batch.set(db.collection("shows").doc("phase1_adele_show").collection("ticketTypes").doc("general_admission"), {
    name: "Adele Show General Admission",
    description: "Phase 1 emulator Adele Show GA ticket",
    priceCents: 3500,
    bookingFeeCents: 250,
    currency: "AUD",
    quantityTotal: 8,
    quantitySold: 0,
    quantityReserved: 0,
    saleStartAt: futureDate(-1),
    saleEndAt: futureDate(35),
    maxPerOrder: 6,
    active: true,
    displayOrder: 1,
    createdAt: now,
    updatedAt: now,
  });

  batch.set(db.collection("auditLog").doc(ids.audit), {
    actorUid: ids.adminUid,
    action: "ticket_type_create",
    targetType: "show",
    targetId: "phase1_hg_show",
    before: null,
    after: { seeded: true },
    reason: "Phase 1 emulator seed",
    serverTimestamp: now,
  });

  await batch.commit();
}

async function reserveOrder() {
  const showId = "phase1_hg_show";
  const ticketTypeId = "general_admission";
  const quantity = 2;
  const ticketTypeRef = db.collection("shows").doc(showId).collection("ticketTypes").doc(ticketTypeId);
  const orderRef = db.collection("orders").doc(ids.order);

  await db.runTransaction(async (tx) => {
    const ticketTypeSnap = await tx.get(ticketTypeRef);
    if (!ticketTypeSnap.exists) {
      throw new Error("ticket type missing");
    }

    const ticketType = ticketTypeSnap.data();
    const available = ticketType.quantityTotal - ticketType.quantitySold - ticketType.quantityReserved;
    if (available < quantity) {
      throw new Error(`not enough inventory: requested ${quantity}, available ${available}`);
    }

    const totals = cents(quantity, ticketType.priceCents, ticketType.bookingFeeCents);
    tx.update(ticketTypeRef, {
      quantityReserved: FieldValue.increment(quantity),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(orderRef, {
      showId,
      sellingFrontId: "hollywood_groove",
      buyerUid: ids.buyerUid,
      buyerSnapshot: {
        email: "phase1-buyer@example.invalid",
        displayName: "Phase 1 Buyer",
        suburb: "Point Cook",
        email_opt_in: true,
        sms_opt_in: false,
        socials: {},
      },
      status: "pending",
      lineItems: [{
        ticketTypeId,
        name: ticketType.name,
        quantity,
        priceCents: ticketType.priceCents,
        bookingFeeCents: ticketType.bookingFeeCents,
        subtotalCents: totals.subtotalCents,
        bookingFeeTotalCents: totals.bookingFeeCents,
        totalCents: totals.totalCents,
      }],
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      subtotalCents: totals.subtotalCents,
      bookingFeeCents: totals.bookingFeeCents,
      stripeFeeCents: null,
      totalCents: totals.totalCents,
      currency: "AUD",
      createdAt: FieldValue.serverTimestamp(),
      reservationExpiresAt: futureDate(1),
      paidAt: null,
    });
  });
}

async function issuePaidOrder() {
  const orderRef = db.collection("orders").doc(ids.order);
  const ticketTypeRef = db.collection("shows").doc("phase1_hg_show").collection("ticketTypes").doc("general_admission");

  await db.runTransaction(async (tx) => {
    const [orderSnap, ticketTypeSnap] = await Promise.all([
      tx.get(orderRef),
      tx.get(ticketTypeRef),
    ]);

    if (!orderSnap.exists || !ticketTypeSnap.exists) {
      throw new Error("order or ticket type missing");
    }
    const order = orderSnap.data();
    const ticketType = ticketTypeSnap.data();
    const quantity = order.lineItems[0].quantity;

    if (ticketType.quantityReserved < quantity) {
      throw new Error("reserved inventory is lower than order quantity");
    }

    tx.update(ticketTypeRef, {
      quantityReserved: FieldValue.increment(-quantity),
      quantitySold: FieldValue.increment(quantity),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(orderRef, {
      status: "paid",
      stripeCheckoutSessionId: "cs_test_phase1",
      stripePaymentIntentId: "pi_test_phase1",
      stripeFeeCents: 76,
      paidAt: FieldValue.serverTimestamp(),
    });
    tx.set(orderRef.collection("payments").doc("payment_phase1"), {
      type: "charge",
      stripeId: "pi_test_phase1",
      amountCents: order.totalCents,
      feeCents: 76,
      status: "succeeded",
      createdAt: FieldValue.serverTimestamp(),
      reason: null,
    });

    [ids.ticketOne, ids.ticketTwo].forEach((ticketId, index) => {
      tx.set(db.collection("tickets").doc(ticketId), {
        orderId: ids.order,
        showId: "phase1_hg_show",
        sellingFrontId: "hollywood_groove",
        ticketTypeId: "general_admission",
        holderName: index === 0 ? "Phase Buyer" : "Phase Friend",
        holderEmail: index === 0 ? "phase1-buyer@example.invalid" : "phase1-friend@example.invalid",
        holderPhone: null,
        holderEmailOptIn: index === 0,
        holderSmsOptIn: false,
        holderConsentSource: "ticket_purchase",
        holderConsentAt: FieldValue.serverTimestamp(),
        holderMemberUid: index === 0 ? ids.buyerUid : null,
        status: "valid",
        qrTokenHash: sha256(`${ticketId}:phase1-secret`),
        issuedAt: FieldValue.serverTimestamp(),
        usedAt: null,
        usedByStaffUid: null,
      });
    });
  });
}

async function assertOversellBlocked() {
  const ticketTypeRef = db.collection("shows").doc("phase1_hg_show").collection("ticketTypes").doc("general_admission");
  let blocked = false;

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ticketTypeRef);
      const ticketType = snap.data();
      const requested = 4;
      const available = ticketType.quantityTotal - ticketType.quantitySold - ticketType.quantityReserved;
      if (available < requested) {
        throw new Error(`oversell blocked: requested ${requested}, available ${available}`);
      }
    });
  } catch (error) {
    blocked = error.message.startsWith("oversell blocked:");
  }

  if (!blocked) {
    throw new Error("expected oversell reservation to be blocked");
  }
}

async function recordPartialRefund() {
  const orderRef = db.collection("orders").doc(ids.order);
  const ticketRef = db.collection("tickets").doc(ids.ticketTwo);
  const refundRef = db.collection("refunds").doc(ids.refund);

  await db.runTransaction(async (tx) => {
    const [orderSnap, ticketSnap] = await Promise.all([
      tx.get(orderRef),
      tx.get(ticketRef),
    ]);
    if (!orderSnap.exists || !ticketSnap.exists) {
      throw new Error("order or ticket missing for refund");
    }

    tx.update(orderRef, { status: "partially_refunded" });
    tx.update(ticketRef, { status: "refunded" });
    tx.set(refundRef, {
      orderId: ids.order,
      ticketIds: [ids.ticketTwo],
      amountCents: 2500,
      bookingFeeRefundedCents: 0,
      stripeFeeNotReturnedCents: 76,
      reason: "Phase 1 lifecycle test refund",
      forceAfterScan: false,
      stripeRefundId: "re_test_phase1",
      status: "succeeded",
      initiatedByUid: ids.adminUid,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
}

async function signInWithCustomToken(uid) {
  const customToken = await auth.createCustomToken(uid);
  const response = await fetch(`http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Auth emulator sign-in failed for ${uid}: ${JSON.stringify(body)}`);
  }
  return body.idToken;
}

async function firestoreRest(method, path, idToken, body = null) {
  const url = `http://${FIRESTORE_EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function assertStatus(label, actual, expected) {
  const expectedSet = Array.isArray(expected) ? expected : [expected];
  if (!expectedSet.includes(actual)) {
    throw new Error(`${label}: expected HTTP ${expectedSet.join(" or ")}, got ${actual}`);
  }
}

async function runRulesSmokeTests() {
  const [buyerToken, otherToken, adminToken, staffToken] = await Promise.all([
    signInWithCustomToken(ids.buyerUid),
    signInWithCustomToken(ids.otherUid),
    signInWithCustomToken(ids.adminUid),
    signInWithCustomToken(ids.staffUid),
  ]);

  const publicFront = await firestoreRest("GET", "sellingFronts/hollywood_groove", null);
  assertStatus("public can read active selling front", publicFront.status, 200);

  const buyerOrder = await firestoreRest("GET", `orders/${ids.order}`, buyerToken);
  assertStatus("buyer can read own order", buyerOrder.status, 200);

  const otherOrder = await firestoreRest("GET", `orders/${ids.order}`, otherToken);
  assertStatus("other buyer cannot read order", otherOrder.status, [403, 404]);

  const buyerTicket = await firestoreRest("GET", `tickets/${ids.ticketOne}`, buyerToken);
  assertStatus("buyer can read holder ticket", buyerTicket.status, 200);

  const otherTicket = await firestoreRest("GET", `tickets/${ids.ticketOne}`, otherToken);
  assertStatus("other buyer cannot read ticket", otherTicket.status, [403, 404]);

  const staffTicket = await firestoreRest("GET", `tickets/${ids.ticketOne}`, staffToken);
  assertStatus("eligible door staff can read venue ticket", staffTicket.status, 200);

  const adminAudit = await firestoreRest("GET", `auditLog/${ids.audit}`, adminToken);
  assertStatus("platform admin can read audit log", adminAudit.status, 200);

  const buyerAudit = await firestoreRest("GET", `auditLog/${ids.audit}`, buyerToken);
  assertStatus("buyer cannot read audit log", buyerAudit.status, [403, 404]);

  const forbiddenOrderCreate = await firestoreRest("PATCH", "orders/phase1_forbidden_client_order", buyerToken, {
    fields: {
      buyerUid: { stringValue: ids.buyerUid },
      showId: { stringValue: "phase1_hg_show" },
      status: { stringValue: "paid" },
    },
  });
  assertStatus("client cannot create order ledger docs", forbiddenOrderCreate.status, [403, 404]);

  return {
    publicFront: publicFront.status,
    buyerOrder: buyerOrder.status,
    otherOrder: otherOrder.status,
    buyerTicket: buyerTicket.status,
    otherTicket: otherTicket.status,
    staffTicket: staffTicket.status,
    adminAudit: adminAudit.status,
    buyerAudit: buyerAudit.status,
    forbiddenOrderCreate: forbiddenOrderCreate.status,
  };
}

async function assertLifecycleState() {
  const [ticketTypeSnap, orderSnap, ticketOneSnap, ticketTwoSnap, refundSnap] = await Promise.all([
    db.collection("shows").doc("phase1_hg_show").collection("ticketTypes").doc("general_admission").get(),
    db.collection("orders").doc(ids.order).get(),
    db.collection("tickets").doc(ids.ticketOne).get(),
    db.collection("tickets").doc(ids.ticketTwo).get(),
    db.collection("refunds").doc(ids.refund).get(),
  ]);

  const ticketType = ticketTypeSnap.data();
  const order = orderSnap.data();
  const ticketOne = ticketOneSnap.data();
  const ticketTwo = ticketTwoSnap.data();

  if (ticketType.quantitySold !== 2 || ticketType.quantityReserved !== 0) {
    throw new Error(`unexpected inventory state: ${JSON.stringify(ticketType)}`);
  }
  if (order.status !== "partially_refunded") {
    throw new Error(`unexpected order status: ${order.status}`);
  }
  if (ticketOne.status !== "valid" || ticketTwo.status !== "refunded") {
    throw new Error(`unexpected ticket states: ${ticketOne.status}/${ticketTwo.status}`);
  }
  if (!refundSnap.exists) {
    throw new Error("refund record missing");
  }

  return {
    quantitySold: ticketType.quantitySold,
    quantityReserved: ticketType.quantityReserved,
    orderStatus: order.status,
    ticketStatuses: [ticketOne.status, ticketTwo.status],
  };
}

async function main() {
  console.log("PHASE1_TICKETING_EMULATOR_START");
  await cleanPhase1Data();
  await seedUsers();
  await seedTicketingConfig();
  await reserveOrder();
  await issuePaidOrder();
  await assertOversellBlocked();
  await recordPartialRefund();
  const lifecycle = await assertLifecycleState();
  const rules = await runRulesSmokeTests();

  console.log(JSON.stringify({
    ok: true,
    projectId: PROJECT_ID,
    firestoreEmulator: FIRESTORE_EMULATOR_HOST,
    authEmulator: AUTH_EMULATOR_HOST,
    sellingFronts: ids.fronts,
    lifecycle,
    rules,
  }, null, 2));
  console.log("PHASE1_TICKETING_EMULATOR_OK");
}

main().catch((error) => {
  console.error("PHASE1_TICKETING_EMULATOR_FAILED");
  console.error(error);
  process.exit(1);
});
