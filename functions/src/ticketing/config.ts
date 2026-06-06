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

let stripeClient: ReturnType<typeof StripeClient> | null = null;

export function getTicketingDb() {
  return getFirestore(TICKETING_DATABASE_ID);
}

export function getCheckoutBaseUrl(): string {
  return process.env.HG_CHECKOUT_BASE_URL || "https://app.hollywoodgroove.com.au";
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
