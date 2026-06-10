import * as admin from "firebase-admin";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import { REGION } from "./ticketing/config";

type CheckDisplayNameAvailableResult = {
  available: boolean;
};

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "displayName must be a string.");
  }

  const displayName = value.trim();
  if (displayName.length < 1 || displayName.length > 50) {
    throw new HttpsError(
      "invalid-argument",
      "displayName must be between 1 and 50 characters.",
    );
  }

  return displayName;
}

export const checkDisplayNameAvailable = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
  },
  async (request): Promise<CheckDisplayNameAvailableResult> => {
    const authRequest = requireAuth(request, null, {
      keyPrefix: "checkDisplayNameAvailable",
      maxCalls: 30,
      windowMs: 60 * 1000,
    });

    const displayName = normalizeDisplayName(request.data?.displayName);
    const snapshot = await admin
      .database()
      .ref("members")
      .orderByChild("display_name")
      .equalTo(displayName)
      .limitToFirst(2)
      .get();

    let available = true;
    snapshot.forEach((child) => {
      if (child.key !== authRequest.auth.uid) {
        available = false;
      }
    });

    logger.info("Display name availability checked", {
      uid: authRequest.auth.uid,
      available,
    });

    return { available };
  },
);
