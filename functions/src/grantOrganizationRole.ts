import * as admin from "firebase-admin";
import { ServerValue } from "firebase-admin/database";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";
import {
  OrgRole,
  asRecord,
  ensureCallerCanManageOrg,
  ensureOrganizationExists,
  nonEmptyString,
  normalizeOrgRole,
  rolesFromValue,
  updateOrgOperatorClaims,
  writeOrgAuditLog,
} from "./lib/orgAccess";
import { REGION } from "./ticketing/config";

interface GrantOrganizationRoleInput {
  orgId: string;
  role: OrgRole;
  targetUid?: string;
  email?: string;
}

interface RevokeOrganizationRoleInput {
  orgId: string;
  role: OrgRole;
  targetUid: string;
}

function normalizeEmail(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text) return null;
  const lower = text.toLowerCase();
  return lower.includes("@") ? lower : null;
}

function validateGrantInput(data: unknown): GrantOrganizationRoleInput {
  const rec = asRecord(data);
  const orgId = nonEmptyString(rec.orgId);
  if (!orgId) {
    throw new HttpsError("invalid-argument", "orgId is required.");
  }
  const role = normalizeOrgRole(rec.role);
  if (!role) {
    throw new HttpsError("invalid-argument", "role is invalid.");
  }
  const targetUid = nonEmptyString(rec.targetUid);
  const email = normalizeEmail(rec.email);
  if (!targetUid && !email) {
    throw new HttpsError("invalid-argument", "Provide either targetUid or email.");
  }
  return {
    orgId,
    role,
    targetUid: targetUid ?? undefined,
    email: email ?? undefined,
  };
}

function validateRevokeInput(data: unknown): RevokeOrganizationRoleInput {
  const rec = asRecord(data);
  const orgId = nonEmptyString(rec.orgId);
  if (!orgId) {
    throw new HttpsError("invalid-argument", "orgId is required.");
  }
  const role = normalizeOrgRole(rec.role);
  if (!role) {
    throw new HttpsError("invalid-argument", "role is invalid.");
  }
  const targetUid = nonEmptyString(rec.targetUid);
  if (!targetUid) {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }
  return { orgId, role, targetUid };
}

async function lookupUserByEmail(email: string): Promise<admin.auth.UserRecord | null> {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (error) {
    if ((error as { code?: string }).code === "auth/user-not-found") {
      return null;
    }
    throw error;
  }
}

async function resolveTarget(input: GrantOrganizationRoleInput): Promise<{
  uid: string;
  email: string | null;
}> {
  if (input.targetUid) {
    const user = await admin.auth().getUser(input.targetUid);
    return { uid: user.uid, email: user.email ?? input.email ?? null };
  }

  if (!input.email) {
    throw new HttpsError("invalid-argument", "Target email is required.");
  }

  const user = await lookupUserByEmail(input.email);
  if (!user) {
    throw new HttpsError(
      "not-found",
      "No Firebase Auth user exists for that email yet. Ask them to sign in first."
    );
  }
  return { uid: user.uid, email: user.email ?? input.email };
}

async function currentOrgRoles(targetUid: string, orgId: string): Promise<OrgRole[]> {
  const snapshot = await admin.database()
    .ref(`members/${targetUid}/org_roles/${orgId}/roles`)
    .once("value");
  return rolesFromValue(snapshot.val());
}

function mergeRole(roles: OrgRole[], role: OrgRole): OrgRole[] {
  return roles.includes(role) ? roles : [...roles, role];
}

function removeRole(roles: OrgRole[], role: OrgRole): OrgRole[] {
  return roles.filter((existing) => existing !== role);
}

export const grantOrganizationRole = onCall(
  { region: REGION, enforceAppCheck: REQUIRE_APP_CHECK },
  async (request) => {
    const partial = asRecord(request.data);
    try {
      requireAuth(request, null, {
        keyPrefix: "grantOrganizationRole",
        maxCalls: 30,
        windowMs: 60 * 1000,
      });
    } catch (err) {
      await writeOrgAuditLog({
        request,
        action: "grantOrganizationRole",
        status: "denied",
        details: partial,
        reason: err instanceof HttpsError ? err.code : "auth_failed",
      });
      throw err;
    }

    const input = validateGrantInput(request.data);
    await ensureOrganizationExists(input.orgId);
    await ensureCallerCanManageOrg(request, input.orgId, input.role);

    const target = await resolveTarget(input);
    const existingRoles = await currentOrgRoles(target.uid, input.orgId);
    const nextRoles = mergeRole(existingRoles, input.role);
    const actorUid = request.auth!.uid;

    const updates: Record<string, unknown> = {
      [`members/${target.uid}/org_roles/${input.orgId}`]: {
        orgId: input.orgId,
        roles: nextRoles,
        status: "active",
        grantedBy: actorUid,
        grantedAt: ServerValue.TIMESTAMP,
        updatedAt: ServerValue.TIMESTAMP,
      },
      [`organizations/${input.orgId}/operators/${target.uid}`]: {
        uid: target.uid,
        email: target.email,
        roles: nextRoles,
        status: "active",
        grantedBy: actorUid,
        grantedAt: ServerValue.TIMESTAMP,
        updatedAt: ServerValue.TIMESTAMP,
      },
      [`organizations/${input.orgId}/member_refs/${target.uid}/operator`]: true,
      [`organizations/${input.orgId}/member_refs/${target.uid}/lastEngagedAt`]: ServerValue.TIMESTAMP,
    };

    await admin.database().ref().update(updates);
    await updateOrgOperatorClaims(target.uid);
    await writeOrgAuditLog({
      request,
      action: "grantOrganizationRole",
      status: "success",
      details: { orgId: input.orgId, targetUid: target.uid, role: input.role },
    });

    logger.info("Organization role granted", {
      orgId: input.orgId,
      targetUid: target.uid,
      role: input.role,
    });

    return {
      ok: true,
      outcome: "granted" as const,
      orgId: input.orgId,
      targetUid: target.uid,
      roles: nextRoles,
      note: "claim takes effect after target's ID token refreshes",
    };
  }
);

export const revokeOrganizationRole = onCall(
  { region: REGION, enforceAppCheck: REQUIRE_APP_CHECK },
  async (request) => {
    const partial = asRecord(request.data);
    try {
      requireAuth(request, null, {
        keyPrefix: "revokeOrganizationRole",
        maxCalls: 30,
        windowMs: 60 * 1000,
      });
    } catch (err) {
      await writeOrgAuditLog({
        request,
        action: "revokeOrganizationRole",
        status: "denied",
        details: partial,
        reason: err instanceof HttpsError ? err.code : "auth_failed",
      });
      throw err;
    }

    const input = validateRevokeInput(request.data);
    await ensureOrganizationExists(input.orgId);
    await ensureCallerCanManageOrg(request, input.orgId, input.role);

    const existingRoles = await currentOrgRoles(input.targetUid, input.orgId);
    if (!existingRoles.includes(input.role)) {
      await writeOrgAuditLog({
        request,
        action: "revokeOrganizationRole",
        status: "failed",
        details: { ...input },
        reason: "role_not_found",
      });
      throw new HttpsError("not-found", "That user does not have that org role.");
    }

    const nextRoles = removeRole(existingRoles, input.role);
    const memberPath = `members/${input.targetUid}/org_roles/${input.orgId}`;
    const operatorPath = `organizations/${input.orgId}/operators/${input.targetUid}`;
    const updates: Record<string, unknown> = {};

    if (nextRoles.length === 0) {
      updates[memberPath] = null;
      updates[operatorPath] = null;
      updates[`organizations/${input.orgId}/member_refs/${input.targetUid}/operator`] = null;
    } else {
      updates[`${memberPath}/roles`] = nextRoles;
      updates[`${memberPath}/updatedAt`] = ServerValue.TIMESTAMP;
      updates[`${operatorPath}/roles`] = nextRoles;
      updates[`${operatorPath}/updatedAt`] = ServerValue.TIMESTAMP;
    }

    await admin.database().ref().update(updates);
    await updateOrgOperatorClaims(input.targetUid);
    await writeOrgAuditLog({
      request,
      action: "revokeOrganizationRole",
      status: "success",
      details: { orgId: input.orgId, targetUid: input.targetUid, role: input.role },
    });

    logger.info("Organization role revoked", {
      orgId: input.orgId,
      targetUid: input.targetUid,
      role: input.role,
    });

    return {
      ok: true,
      outcome: "revoked" as const,
      orgId: input.orgId,
      targetUid: input.targetUid,
      roles: nextRoles,
    };
  }
);
