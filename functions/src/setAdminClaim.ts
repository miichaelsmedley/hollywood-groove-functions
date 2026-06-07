import crypto from "node:crypto";
import * as admin from "firebase-admin";
import { ServerValue } from "firebase-admin/database";
import { logger } from "firebase-functions/v2";
import { HttpsError, CallableRequest, onCall, onRequest } from "firebase-functions/v2/https";
import { requireAuth, RequiredRoleName, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import {
  getPrisApiBaseUrl,
  getPrisIntegrationSecret,
  PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET,
} from "./ticketing/config";

const REGION = "asia-southeast1";
const BOOTSTRAP_ADMIN_EMAIL = "miichael.smedley@gmail.com";

const ADMIN_ROLES = new Set<RequiredRoleName>([
  "platform_admin",
  "event_admin",
  "venue_manager",
  "door_staff",
]);
const TICKETING_USER_ROLES = new Set<TicketingUserRole>([
  "none",
  "scanner",
  "ticketer",
  "ticket_admin",
  "absolute_admin",
]);
const CLAIM_TO_TICKETING_ROLE: Record<RequiredRoleName, TicketingUserRole> = {
  door_staff: "scanner",
  venue_manager: "ticketer",
  event_admin: "ticket_admin",
  platform_admin: "absolute_admin",
};
const TICKETING_ROLE_TO_CLAIM: Record<Exclude<TicketingUserRole, "none">, RequiredRoleName> = {
  scanner: "door_staff",
  ticketer: "venue_manager",
  ticket_admin: "event_admin",
  absolute_admin: "platform_admin",
};
const TICKETING_CLAIMS: RequiredRoleName[] = [
  "door_staff",
  "venue_manager",
  "event_admin",
  "platform_admin",
];

type TicketingUserRole =
  | "none"
  | "scanner"
  | "ticketer"
  | "ticket_admin"
  | "absolute_admin";

type SetAdminClaimInput = {
  targetUid?: string;
  email?: string;
  role: RequiredRoleName;
  grant: boolean;
};

type AuditStatus = "success" | "denied" | "failed";
type PrisSyncStatus = "updated" | "skipped" | "failed";

type PrisSyncResult = {
  status: PrisSyncStatus;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPartialInput(data: unknown): Partial<SetAdminClaimInput> {
  if (!isRecord(data)) {
    return {};
  }

  const targetUid =
    typeof data.targetUid === "string" ? data.targetUid : undefined;
  const email = typeof data.email === "string" ? data.email : undefined;
  const role = typeof data.role === "string" && ADMIN_ROLES.has(data.role as RequiredRoleName)
    ? data.role as RequiredRoleName
    : undefined;
  const grant = typeof data.grant === "boolean" ? data.grant : undefined;

  return { targetUid, email, role, grant };
}

function normaliseEmail(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const email = value.trim().toLowerCase();
  return email.includes("@") ? email : undefined;
}

function normaliseTicketingRole(value: unknown): TicketingUserRole | null {
  if (typeof value !== "string") return null;
  const role = value.trim().toLowerCase();
  return TICKETING_USER_ROLES.has(role as TicketingUserRole)
    ? role as TicketingUserRole
    : null;
}

function ticketingRoleFromClaims(claims: Record<string, unknown>): TicketingUserRole {
  if (claims.platform_admin === true) return "absolute_admin";
  if (claims.event_admin === true) return "ticket_admin";
  if (claims.venue_manager === true) return "ticketer";
  if (claims.door_staff === true) return "scanner";
  return "none";
}

function applyExclusiveTicketingRole(
  claims: Record<string, unknown>,
  role: TicketingUserRole,
): void {
  for (const claim of TICKETING_CLAIMS) {
    delete claims[claim];
  }
  if (role === "none") return;
  claims[TICKETING_ROLE_TO_CLAIM[role]] = true;
}

function validateInput(data: unknown): SetAdminClaimInput {
  const partial = readPartialInput(data);
  const targetUid = partial.targetUid?.trim();
  const email = normaliseEmail(partial.email);

  if (targetUid && email) {
    throw new HttpsError(
      "invalid-argument",
      "Provide either targetUid or email, not both.",
    );
  }
  if (!targetUid && !email) {
    throw new HttpsError(
      "invalid-argument",
      "Provide either targetUid or a valid email.",
    );
  }
  if (!partial.role) {
    throw new HttpsError("invalid-argument", "role must be a supported admin role.");
  }
  if (typeof partial.grant !== "boolean") {
    throw new HttpsError("invalid-argument", "grant must be a boolean.");
  }

  return {
    targetUid,
    email,
    role: partial.role,
    grant: partial.grant,
  };
}

async function resolveTargetUser(
  input: SetAdminClaimInput,
): Promise<admin.auth.UserRecord> {
  if (input.targetUid) {
    try {
      return await admin.auth().getUser(input.targetUid);
    } catch (error) {
      logger.warn("setAdminClaim target user not found by uid", {
        targetUid: input.targetUid,
        role: input.role,
        grant: input.grant,
        error,
      });
      throw new HttpsError("not-found", "Target user does not exist.");
    }
  }

  if (!input.email) {
    throw new HttpsError(
      "invalid-argument",
      "Provide either targetUid or a valid email.",
    );
  }

  try {
    return await admin.auth().getUserByEmail(input.email);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "auth/user-not-found") {
      throw new HttpsError(
        "failed-precondition",
        "Target user must sign in to Hollywood Groove with this email before an admin claim can be changed.",
      );
    }
    logger.error("Could not resolve setAdminClaim target by email", {
      email: input.email,
      role: input.role,
      grant: input.grant,
      error,
    });
    throw new HttpsError("internal", "Could not verify target account.");
  }
}

function isBootstrapCaller(token: Record<string, unknown>): boolean {
  return token.email === BOOTSTRAP_ADMIN_EMAIL && token.email_verified === true;
}

function isPlatformAdminCaller(token: Record<string, unknown>): boolean {
  return token.platform_admin === true;
}

async function writeAuditLog(params: {
  request: CallableRequest<unknown>;
  input: Partial<SetAdminClaimInput>;
  status: AuditStatus;
  reason?: string;
}): Promise<void> {
  const actorUid = params.request.auth?.uid ?? null;
  const actorEmail = params.request.auth?.token.email ?? null;

  await admin.database().ref("audit_log").push({
    actorUid,
    actorEmail,
    action: "setAdminClaim",
    targetUid: params.input.targetUid ?? null,
    targetEmail: params.input.email ?? null,
    role: params.input.role ?? null,
    grant: params.input.grant ?? null,
	    status: params.status,
	    reason: params.reason ?? null,
	    at: ServerValue.TIMESTAMP,
	  });
	}

function secureCompareSecret(
  provided: string | null,
  expected: string | null,
): boolean {
  if (!provided || !expected) return false;
  const providedHash = crypto.createHash("sha256").update(provided).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

function extractRequestSecret(request: {
  get(name: string): string | undefined;
}): string | null {
  const headerSecret = request.get("X-PRIS-Integration-Secret")?.trim();
  if (headerSecret) return headerSecret;
  const authHeader = request.get("Authorization")?.trim() || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return bearerMatch ? bearerMatch[1].trim() : null;
}

async function syncPrisTicketingAdminProjection(params: {
  targetUid: string;
  email?: string | null;
  displayName?: string | null;
  ticketingRole: TicketingUserRole;
  actorUid: string;
  actorEmail?: string | null;
}): Promise<PrisSyncResult> {
  const email = normaliseEmail(params.email);
  if (!email) return { status: "skipped", reason: "target_email_missing" };

  const secret = getPrisIntegrationSecret();
  if (!secret) return { status: "skipped", reason: "pris_secret_missing" };

  try {
    const response = await fetch(
      `${getPrisApiBaseUrl()}/api/integrations/hollywood-groove/ticketing-admins`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PRIS-Integration-Secret": secret,
        },
        body: JSON.stringify({
          email,
          displayName: params.displayName || null,
          firebaseUid: params.targetUid,
          ticketing_role: params.ticketingRole,
          actorUid: params.actorUid,
          actorEmail: params.actorEmail || null,
          source: "hollywood-groove-pwa",
        }),
      },
    );

    const raw = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const reason =
        typeof payload.error === "string"
          ? payload.error
          : raw.slice(0, 120) || `pris_${response.status}`;
      logger.warn("PRIS ticketing admin projection failed", {
        email,
        status: response.status,
        reason,
      });
      return { status: "failed", reason };
    }

    const outcome =
      typeof payload.outcome === "string" ? payload.outcome : "updated";
    return { status: "updated", reason: outcome };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    logger.warn("PRIS ticketing admin projection request failed", {
      email,
      reason,
    });
    return { status: "failed", reason };
  }
}

function noteForClaimUpdate(
  input: SetAdminClaimInput,
  prisSync: PrisSyncResult | null,
): string {
  const base = "claim takes effect after target's ID token refreshes";
  if (!prisSync) return base;
  if (prisSync.status === "updated") {
    return `${base}; PRIS user record updated`;
  }
  if (prisSync.status === "skipped") {
    return `${base}; PRIS sync skipped (${prisSync.reason || "not configured"})`;
  }
  return `${base}; PRIS sync failed (${prisSync.reason || "unknown error"})`;
}

async function writePrisSyncAuditLog(params: {
  actorEmail?: string | null;
  targetUid?: string | null;
  targetEmail?: string | null;
  ticketingRole?: TicketingUserRole | null;
  status: AuditStatus;
  reason?: string;
}): Promise<void> {
  await admin.database().ref("audit_log").push({
    actorUid: "pris-crm",
    actorEmail: params.actorEmail ?? null,
    action: "syncTicketingAdminFromPrisUser",
    targetUid: params.targetUid ?? null,
    targetEmail: params.targetEmail ?? null,
    role: params.ticketingRole ?? null,
    status: params.status,
    reason: params.reason ?? null,
    at: ServerValue.TIMESTAMP,
  });
}

export const setAdminClaim = onCall(
  {
    region: REGION,
    enforceAppCheck: REQUIRE_APP_CHECK,
    secrets: [PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET],
  },
	  async (request) => {
	    const partialInput = readPartialInput(request.data);
	    let auditWritten = false;

	    try {
	      const authRequest = requireAuth(request, null, {
        keyPrefix: "setAdminClaim",
        maxCalls: 20,
        windowMs: 60 * 1000,
      });

	      const token = authRequest.auth.token;
	      if (!isBootstrapCaller(token) && !isPlatformAdminCaller(token)) {
	        await writeAuditLog({
	          request,
	          input: partialInput,
	          status: "denied",
	          reason: "caller lacks bootstrap email or platform_admin claim",
	        });
	        auditWritten = true;
	        throw new HttpsError("permission-denied", "Only platform admins can grant admin claims.");
	      }

      const input = validateInput(request.data);

      const targetUser = await resolveTargetUser(input);
      const resolvedInput: SetAdminClaimInput = {
        ...input,
        targetUid: targetUser.uid,
        email: targetUser.email?.toLowerCase() ?? input.email,
      };

      const nextClaims = { ...(targetUser.customClaims ?? {}) };
      if (input.grant) {
        applyExclusiveTicketingRole(nextClaims, CLAIM_TO_TICKETING_ROLE[input.role]);
      } else {
        delete nextClaims[input.role];
      }

      await admin.auth().setCustomUserClaims(targetUser.uid, nextClaims);
      const prisSync = await syncPrisTicketingAdminProjection({
        targetUid: targetUser.uid,
        email: resolvedInput.email,
        displayName: targetUser.displayName || null,
        ticketingRole: ticketingRoleFromClaims(nextClaims),
        actorUid: authRequest.auth.uid,
        actorEmail: authRequest.auth.token.email || null,
      });
	      await writeAuditLog({
	        request,
	        input: resolvedInput,
	        status: "success",
	      });
	      auditWritten = true;

      logger.info("Admin custom claim updated", {
        actorUid: authRequest.auth.uid,
        targetUid: targetUser.uid,
        targetEmail: resolvedInput.email,
        role: input.role,
        grant: input.grant,
      });

      return {
        ok: true,
        note: noteForClaimUpdate(input, prisSync),
        prisSync,
      };
	    } catch (error) {
	      if (error instanceof HttpsError) {
	        if (!auditWritten) {
	          await writeAuditLog({
	            request,
	            input: partialInput,
	            status: error.code === "unauthenticated" || error.code === "permission-denied"
	              ? "denied"
	              : "failed",
	            reason: error.code,
	          });
	        }
	        throw error;
	      }

	      if (!auditWritten) {
	        await writeAuditLog({
	          request,
	          input: partialInput,
	          status: "failed",
	          reason: error instanceof Error ? error.message : "unknown error",
	        });
	      }
	      throw error;
	    }
  }
);

export const syncTicketingAdminFromPrisUser = onRequest(
  {
    region: REGION,
    invoker: "public",
    secrets: [PRIS_HOLLYWOOD_GROOVE_INTEGRATION_SECRET],
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response
        .set("Allow", "POST")
        .status(405)
        .json({ error: "method_not_allowed" });
      return;
    }

    const expectedSecret = getPrisIntegrationSecret();
    if (!expectedSecret) {
      response.status(503).json({ error: "integration_secret_not_configured" });
      return;
    }
    if (!secureCompareSecret(extractRequestSecret(request), expectedSecret)) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }

    const body = isRecord(request.body) ? request.body : {};
    const email = normaliseEmail(body.email);
    let ticketingRole =
      normaliseTicketingRole(body.ticketing_role) ||
      normaliseTicketingRole(body.ticketingRole);
    if (!ticketingRole) {
      const legacyGrantValue = body.grant ?? body.ticketing_event_admin;
      if (typeof legacyGrantValue === "boolean") {
        ticketingRole = legacyGrantValue ? "ticket_admin" : "none";
      }
    }
    const actorEmail =
      typeof body.actorEmail === "string" ? body.actorEmail : null;

    if (!email || !ticketingRole) {
      await writePrisSyncAuditLog({
        actorEmail,
        targetEmail: email,
        ticketingRole,
        status: "failed",
        reason: "invalid_request",
      });
      response.status(400).json({
        error: "invalid_request",
        message: "email and ticketing_role are required.",
      });
      return;
    }

    try {
      const targetUser = await admin.auth().getUserByEmail(email);
      const nextClaims = { ...(targetUser.customClaims ?? {}) };
      applyExclusiveTicketingRole(nextClaims, ticketingRole);
      await admin.auth().setCustomUserClaims(targetUser.uid, nextClaims);
      await writePrisSyncAuditLog({
        actorEmail,
        targetUid: targetUser.uid,
        targetEmail: email,
        ticketingRole,
        status: "success",
      });
      response.json({
        ok: true,
        email,
        targetUid: targetUser.uid,
        ticketingRole,
        note: "claim takes effect after target's ID token refreshes",
      });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      const userMissing = code === "auth/user-not-found";
      const reason = userMissing
        ? "hollywood_groove_user_not_found"
        : error instanceof Error
          ? error.message
          : "unknown_error";
      await writePrisSyncAuditLog({
        actorEmail,
        targetEmail: email,
        ticketingRole,
        status: userMissing ? "denied" : "failed",
        reason,
      });
      response.status(userMissing ? 412 : 500).json({
        error: reason,
        message: userMissing
          ? "This PRIS user must sign in to Hollywood Groove once before ticketing access can be changed."
          : "Could not update the Hollywood Groove ticketing role.",
      });
    }
  },
);
