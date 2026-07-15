import admin from "firebase-admin";

const PROJECT_ID =
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  "theta-inkwell-448908-g9";

// The Admin SDK cannot infer the RTDB instance outside GCP.
const DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://theta-inkwell-448908-g9-default-rtdb.asia-southeast1.firebasedatabase.app";

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID, databaseURL: DATABASE_URL });
}

const db = admin.database();

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanOrUndefined(value) {
  return typeof value === "boolean" ? value : undefined;
}

function compactProjection(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function projectShowMeta(meta, isTestNamespace) {
  const title = stringOrUndefined(meta?.title);
  if (!title) return null;

  const isTestShow =
    booleanOrUndefined(meta?.isTestShow) ??
    booleanOrUndefined(meta?.is_test) ??
    booleanOrUndefined(meta?.test) ??
    isTestNamespace;

  return compactProjection({
    title,
    startDate: stringOrUndefined(meta?.startDate) ?? "",
    status: stringOrUndefined(meta?.status),
    isTestShow,
    is_test: isTestShow,
    test: isTestShow,
    venueName: stringOrUndefined(meta?.venueName),
    ticketUrl: stringOrUndefined(meta?.ticketUrl),
    orgId: stringOrUndefined(meta?.orgId),
    platformOwner: stringOrUndefined(meta?.platformOwner),
    schemaVersion: numberOrUndefined(meta?.schemaVersion),
    publishedAt: numberOrUndefined(meta?.publishedAt),
    updatedAt: admin.database.ServerValue.TIMESTAMP,
  });
}

async function backfillNamespace({ showsPath, indexPath, isTestNamespace }) {
  const snapshot = await db.ref(showsPath).get();
  const updates = {};

  snapshot.forEach((showSnapshot) => {
    const projection = projectShowMeta(showSnapshot.child("meta").val(), isTestNamespace);
    if (projection) {
      updates[`${indexPath}/${showSnapshot.key}`] = projection;
    }
  });

  if (Object.keys(updates).length === 0) {
    console.log(`No indexable shows found under ${showsPath}.`);
    return;
  }

  await db.ref().update(updates);
  console.log(`Backfilled ${Object.keys(updates).length} rows under ${indexPath}.`);
}

await backfillNamespace({
  showsPath: "shows",
  indexPath: "shows_index",
  isTestNamespace: false,
});

await backfillNamespace({
  showsPath: "test/shows",
  indexPath: "test/shows_index",
  isTestNamespace: true,
});
