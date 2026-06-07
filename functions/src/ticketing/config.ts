import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import StripeClient from "stripe";

export const REGION = "asia-southeast1";
export const TICKETING_DATABASE_ID = process.env.HG_TICKETING_DATABASE_ID
  || (process.env.FIRESTORE_EMULATOR_HOST ? "(default)" : "ticketing");

export const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
export const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
export const PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET = defineSecret(
  "PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET"
);
export const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

let stripeClient: ReturnType<typeof StripeClient> | null = null;

export function getTicketingDb() {
  return getFirestore(TICKETING_DATABASE_ID);
}

export function getCheckoutBaseUrl(): string {
  return process.env.HG_CHECKOUT_BASE_URL || "https://app.hollywoodgroove.com.au";
}

export function getTicketWalletUrl(): string {
  return `${getCheckoutBaseUrl()}/tickets`;
}

// Landing page for a shared-ticket invite. Unlike the wallet, this route shows
// the event, prompts the recipient to sign in with the invited email, and then
// claims the pending ticket into their wallet. The optional showId lets the
// page render the event the recipient is being given a ticket to.
export function getTicketClaimUrl(showId?: string): string {
  const base = `${getCheckoutBaseUrl()}/tickets/claim`;
  return showId ? `${base}?show=${encodeURIComponent(showId)}` : base;
}

// Continue URL for a passwordless email-link sign-in. The origin is fixed to our
// own checkout domain (an Authorized Domain in Firebase Auth) — never taken from
// the client — so a minted link can't be pointed at an attacker host. returnPath
// is an optional in-app relative path the buyer lands on after sign-in completes.
export function getAuthFinishUrl(returnPath?: string): string {
  const base = `${getCheckoutBaseUrl()}/auth/finish`;
  if (
    typeof returnPath === "string" &&
    returnPath.startsWith("/") &&
    !returnPath.startsWith("//") &&
    returnPath.length <= 512
  ) {
    return `${base}?return=${encodeURIComponent(returnPath)}`;
  }
  return base;
}

export function shouldUseMockStripeCheckout(): boolean {
  return process.env.HG_STRIPE_MOCK_CHECKOUT === "true";
}

export function getPrisApiBaseUrl(): string {
  return (process.env.HG_PRIS_API_BASE_URL || "https://pris-crm.miichael-smedley.workers.dev")
    .replace(/\/+$/, "");
}

function readSecretValue(secret: { value: () => string }, envNames: string[]): string | null {
  for (const envName of envNames) {
    const value = process.env[envName];
    if (value) {
      return value;
    }
  }

  try {
    const value = secret.value();
    return value || null;
  } catch {
    return null;
  }
}

export function getStripeSecretKey(): string | null {
  return readSecretValue(STRIPE_SECRET_KEY, ["STRIPE_SECRET_KEY", "HG_STRIPE_SECRET_KEY"]);
}

export function getStripeWebhookSecret(): string | null {
  return readSecretValue(STRIPE_WEBHOOK_SECRET, ["STRIPE_WEBHOOK_SECRET", "HG_STRIPE_WEBHOOK_SECRET"]);
}

export function getPrisIntegrationSecret(): string | null {
  return readSecretValue(PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET, [
    "PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET",
    "HG_PRIS_INTEGRATION_SECRET",
  ]);
}

export function getResendApiKey(): string | null {
  return readSecretValue(RESEND_API_KEY, ["RESEND_API_KEY", "HG_RESEND_API_KEY"]);
}

export function getEmailFromAddress(): string {
  return process.env.HG_EMAIL_FROM || "Hollywood Groove <tickets@hollywoodgroove.com.au>";
}

function sanitizeStripeSecret(raw: string): string {
  // Stripe-node sets `Authorization: Bearer <key>` on every request. Node's
  // HTTP layer rejects any non-printable / non-ASCII char in header values
  // with ERR_INVALID_CHAR. Pasting through pbpaste / the dashboard copy button
  // can introduce stray whitespace, BOM, or control characters that survive
  // file-roundtripping. Trim aggressively and reject anything still non-ASCII
  // so we fail fast at startup instead of mid-checkout.
  const trimmed = raw.replace(/^[\s﻿​-‍]+|[\s﻿​-‍]+$/g, "");
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7E]/.test(trimmed)) {
    throw new Error(
      "Stripe secret key contains non-printable / non-ASCII characters after trimming. " +
        "Re-set STRIPE_SECRET_KEY via `firebase functions:secrets:set` with a clean paste."
    );
  }
  return trimmed;
}

export function getStripeClient(): ReturnType<typeof StripeClient> {
  const secretKey = getStripeSecretKey();
  if (!secretKey) {
    throw new Error("Stripe secret key is not configured.");
  }

  if (!stripeClient) {
    stripeClient = new StripeClient(sanitizeStripeSecret(secretKey));
  }

  return stripeClient;
}
