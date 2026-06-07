import { getAuth } from "firebase-admin/auth";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REQUIRE_APP_CHECK } from "./lib/requireAuth";
import { sendEmail } from "./lib/email/emailService";
import { signInLinkEmail } from "./lib/email/templates";
import {
  getAuthFinishUrl,
  REGION,
  RESEND_API_KEY,
} from "./ticketing/config";
import { asRecord, nonEmptyString, normaliseEmail } from "./ticketing/shared";

// Passwordless email-link sign-in, delivered through our own Resend domain
// instead of Firebase Auth's built-in sender. The default firebaseapp.com sender
// is routinely quarantined by corporate mail (M365/Outlook); minting the link
// server-side and sending it from hollywoodgroove.com.au (SPF/DKIM verified) is
// far more deliverable. The link itself is a standard Firebase email-link, so the
// existing /auth/finish completion flow (signInWithEmailLink) is unchanged.
//
// This callable is intentionally UNAUTHENTICATED (the user has no account yet),
// so it leans on App Check + a per-email rate limit for abuse protection, and the
// continue URL origin is server-fixed to block open-redirect / link spoofing.

type SignInLinkInput = {
  email: string;
  returnPath?: string;
  sellingFrontId?: string;
};

// In-memory, per-instance limiter keyed by email. Same trade-off as the rest of
// the codebase's limiter (a distributed limiter is a later phase); combined with
// App Check it's enough to stop an unauthenticated abuser from blasting links.
const emailBuckets = new Map<string, number[]>();
const MAX_PER_EMAIL = 5;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_BUCKETS = 5000;

function enforceEmailRateLimit(email: string): void {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const recent = (emailBuckets.get(email) ?? []).filter((t) => t >= windowStart);

  if (recent.length >= MAX_PER_EMAIL) {
    logger.warn("Sign-in link rate limit exceeded", { email });
    throw new HttpsError(
      "resource-exhausted",
      "Too many sign-in emails for this address. Please wait a few minutes and try again.",
    );
  }

  recent.push(now);
  emailBuckets.set(email, recent);

  if (emailBuckets.size > MAX_BUCKETS) {
    const firstKey = emailBuckets.keys().next().value as string | undefined;
    if (firstKey) emailBuckets.delete(firstKey);
  }
}

function validateInput(data: unknown): SignInLinkInput {
  const record = asRecord(data);
  const email = normaliseEmail(record.email);
  if (!email) {
    throw new HttpsError("invalid-argument", "A valid email address is required.");
  }
  const returnPathRaw = nonEmptyString(record.returnPath);
  const sellingFrontId = nonEmptyString(record.sellingFrontId);
  return {
    email,
    returnPath: returnPathRaw ?? undefined,
    sellingFrontId: sellingFrontId ?? undefined,
  };
}

export const sendEmailSignInLink = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
    secrets: [RESEND_API_KEY],
  },
  async (request) => {
    const input = validateInput(request.data);
    enforceEmailRateLimit(input.email);

    // generateSignInWithEmailLink works for brand-new addresses too (the account
    // is created when the link is completed), so this reveals nothing about
    // whether the email already has an account — no enumeration signal.
    let signInUrl: string;
    try {
      signInUrl = await getAuth().generateSignInWithEmailLink(input.email, {
        url: getAuthFinishUrl(input.returnPath),
        handleCodeInApp: true,
      });
    } catch (error) {
      logger.error("generateSignInWithEmailLink failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HttpsError(
        "internal",
        "Could not create a sign-in link right now. Please try again in a moment.",
      );
    }

    const template = signInLinkEmail({
      sellingFrontId: input.sellingFrontId,
      signInUrl,
    });
    const result = await sendEmail({
      to: input.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    // Unlike the best-effort ticket emails, sign-in delivery is the whole point —
    // if Resend didn't accept it, tell the client so the UI can offer a retry.
    if (!result.delivered) {
      logger.error("Sign-in link email not delivered", {
        provider: result.provider,
        error: result.error,
      });
      throw new HttpsError(
        "internal",
        "We couldn't send your sign-in email just now. Please try again in a moment.",
      );
    }

    logger.info("Sign-in link email sent", { provider: result.provider });
    return { ok: true };
  },
);
