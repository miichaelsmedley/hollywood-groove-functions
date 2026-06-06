import * as admin from "firebase-admin";
import { ServerValue } from "firebase-admin/database";
import { logger } from "firebase-functions/v2";
import { HttpsError, CallableRequest, onCall } from "firebase-functions/v2/https";
import { requireAuth, RequiredRoleName, REQUIRE_APP_CHECK } from "./lib/requireAuth";

const REGION = "asia-southeast1";
const BOOTSTRAP_ADMIN_EMAIL = "miichael.smedley@gmail.com";

const ADMIN_ROLES = new Set<RequiredRoleName>([
  "platform_admin",
  "event_admin",
  "venue_manager",
  "door_staff",
]);

type SetAdminClaimInput = {
  targetUid?: string;
  email?: string;
  role: RequiredRoleName;
  grant: boolean;
};

type AuditStatus = "success" | "denied" | "failed";

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

export const setAdminClaim = onCall(
  { region: REGION, enforceAppCheck: REQUIRE_APP_CHECK },
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
        nextClaims[input.role] = true;
      } else {
        delete nextClaims[input.role];
      }

      await admin.auth().setCustomUserClaims(targetUser.uid, nextClaims);
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
        note: "claim takes effect after target's ID token refreshes",
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
