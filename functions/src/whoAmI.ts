import { onCall } from "firebase-functions/v2/https";
import {
  getCustomClaims,
  isAppCheckPresent,
  requireAuth,
  REQUIRE_APP_CHECK,
} from "./lib/requireAuth";

const REGION = "asia-southeast1";

export const whoAmI = onCall(
  { region: REGION, enforceAppCheck: REQUIRE_APP_CHECK },
  async (request) => {
    const authRequest = requireAuth(request, null, {
      keyPrefix: "whoAmI",
      maxCalls: 60,
      windowMs: 60 * 1000,
    });

    return {
      uid: authRequest.auth.uid,
      email: authRequest.auth.token.email ?? null,
      customClaims: getCustomClaims(authRequest.auth.token),
      appCheckPresent: isAppCheckPresent(authRequest),
    };
  }
);
