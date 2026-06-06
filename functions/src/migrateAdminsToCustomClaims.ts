import * as admin from "firebase-admin";
import { ServerValue } from "firebase-admin/database";
import { logger } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";

const REGION = "asia-southeast1";
const BOOTSTRAP_ADMIN_EMAIL = "miichael.smedley@gmail.com";

function getBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function collectTrueKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, enabled]) => enabled === true || typeof enabled === "object")
    .map(([uid]) => uid);
}

async function writeMigrationAudit(params: {
  actorUid: string;
  actorEmail: string | null;
  targetUid: string;
  source: string;
  tester: boolean;
}): Promise<void> {
  await admin.database().ref("audit_log").push({
    actorUid: params.actorUid,
    actorEmail: params.actorEmail,
    action: "migrateAdminsToCustomClaims",
    targetUid: params.targetUid,
    role: "platform_admin",
    grant: true,
    source: params.source,
    tester: params.tester,
    at: ServerValue.TIMESTAMP,
  });
}

export const migrateAdminsToCustomClaims = onRequest(
  { region: REGION },
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).json({ ok: false, error: "Use POST." });
      return;
    }

    const bearerToken = getBearerToken(request.header("authorization"));
    if (!bearerToken) {
      response.status(401).json({ ok: false, error: "Missing Bearer token." });
      return;
    }

    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(bearerToken);
    } catch (error) {
      logger.warn("Admin migration rejected invalid ID token", { error });
      response.status(401).json({ ok: false, error: "Invalid ID token." });
      return;
    }

    if (decoded.email !== BOOTSTRAP_ADMIN_EMAIL || decoded.email_verified !== true) {
      response.status(403).json({ ok: false, error: "Bootstrap admin email is required." });
      return;
    }

    const database = admin.database();
    const [prodAdminsSnap, testAdminsSnap, testersSnap] = await Promise.all([
      database.ref("admins").get(),
      database.ref("test/admins").get(),
      database.ref("testers").get(),
    ]);

    const prodAdminUids = collectTrueKeys(prodAdminsSnap.val());
    const testAdminUids = collectTrueKeys(testAdminsSnap.val());
    const testerUids = new Set(collectTrueKeys(testersSnap.val()));
    const allAdminUids = Array.from(new Set([...prodAdminUids, ...testAdminUids])).sort();

    let migrated = 0;
    let skippedMissing = 0;
    const missingUids: string[] = [];

    for (const uid of allAdminUids) {
      try {
        const user = await admin.auth().getUser(uid);
        await admin.auth().setCustomUserClaims(uid, {
          ...(user.customClaims ?? {}),
          platform_admin: true,
          ...(testerUids.has(uid) ? { tester: true } : {}),
        });

        await writeMigrationAudit({
          actorUid: decoded.uid,
          actorEmail: decoded.email ?? null,
          targetUid: uid,
          source: prodAdminUids.includes(uid) && testAdminUids.includes(uid)
            ? "admins,test/admins"
            : prodAdminUids.includes(uid)
              ? "admins"
              : "test/admins",
          tester: testerUids.has(uid),
        });
        migrated += 1;
      } catch (error) {
        skippedMissing += 1;
        missingUids.push(uid);
        logger.warn("Skipping admin migration for missing uid", { uid, error });
      }
    }

    response.json({
      ok: true,
      migrated,
      skippedMissing,
      missingUids,
      prodAdminCount: prodAdminUids.length,
      testAdminCount: testAdminUids.length,
      testerCount: testerUids.size,
    });
  }
);
