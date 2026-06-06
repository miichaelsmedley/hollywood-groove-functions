import { HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";

export type RequiredRoleName = "platform_admin" | "event_admin" | "venue_manager" | "door_staff";
export type RequiredRole = RequiredRoleName | readonly RequiredRoleName[] | null;

export type RateLimitOptions = {
  maxCalls?: number;
  windowMs?: number;
  keyPrefix?: string;
};

export type AuthenticatedCallableRequest<T = unknown> = CallableRequest<T> & {
  auth: NonNullable<CallableRequest<T>["auth"]>;
};

const DEFAULT_MAX_CALLS = 60;
const DEFAULT_WINDOW_MS = 60 * 1000;
const MAX_BUCKETS = 5000;

// Strict by default after Phase 0.6. Set HG_REQUIRE_APP_CHECK=false only for
// local/emergency debugging, never for payment-facing production callables.
export const REQUIRE_APP_CHECK = process.env.HG_REQUIRE_APP_CHECK !== "false";

const uidCallBuckets = new Map<string, number[]>();

const RESERVED_CLAIM_KEYS = new Set([
  "aud",
  "auth_time",
  "email",
  "email_verified",
  "exp",
  "firebase",
  "iat",
  "iss",
  "name",
  "phone_number",
  "picture",
  "sub",
  "uid",
  "user_id",
]);

function enforceRateLimit(uid: string, options: RateLimitOptions): void {
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const keyPrefix = options.keyPrefix ?? "default";
  const bucketKey = `${keyPrefix}:${uid}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  const existing = uidCallBuckets.get(bucketKey) ?? [];
  const recent = existing.filter((timestamp) => timestamp >= windowStart);

  if (recent.length >= maxCalls) {
    logger.warn("Callable rate limit exceeded", {
      uid,
      keyPrefix,
      maxCalls,
      windowMs,
    });
    throw new HttpsError("resource-exhausted", "Too many requests. Please try again shortly.");
  }

  recent.push(now);
  uidCallBuckets.set(bucketKey, recent);

  // This is an in-memory, per-instance limiter. A distributed limiter belongs in Phase 1+.
  if (uidCallBuckets.size > MAX_BUCKETS) {
    const firstKey = uidCallBuckets.keys().next().value as string | undefined;
    if (firstKey) {
      uidCallBuckets.delete(firstKey);
    }
  }
}

export function hasRequiredRole(
  token: Record<string, unknown>,
  requiredRole: Exclude<RequiredRole, null>
): boolean {
  const roles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
  return roles.some((role) => token[role] === true);
}

function formatRequiredRole(requiredRole: Exclude<RequiredRole, null>): string {
  const roles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
  return roles.join(" or ");
}

export function isAppCheckPresent<T>(request: CallableRequest<T>): boolean {
  return Boolean(request.app?.appId);
}

export function getCustomClaims(token: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(token).filter(([key]) => !RESERVED_CLAIM_KEYS.has(key))
  );
}

export function requireAuth<T>(
  request: CallableRequest<T>,
  requiredRole: RequiredRole,
  rateLimitOptions: RateLimitOptions = {}
): AuthenticatedCallableRequest<T> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Firebase Auth is required.");
  }

  if (!isAppCheckPresent(request)) {
    const logPayload = {
      uid: request.auth.uid,
      requiredRole,
      strict: REQUIRE_APP_CHECK,
    };

    if (REQUIRE_APP_CHECK) {
      logger.warn("Callable request rejected without App Check token", logPayload);
      throw new HttpsError("failed-precondition", "Firebase App Check is required.");
    }

    logger.warn("Callable request missing App Check token", logPayload);
  }

  enforceRateLimit(request.auth.uid, rateLimitOptions);

  if (requiredRole && !hasRequiredRole(request.auth.token, requiredRole)) {
    throw new HttpsError(
      "permission-denied",
      `Missing required role: ${formatRequiredRole(requiredRole)}.`
    );
  }

  return request as AuthenticatedCallableRequest<T>;
}
