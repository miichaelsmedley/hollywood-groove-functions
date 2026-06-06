import * as admin from "firebase-admin";
import { ServerValue } from "firebase-admin/database";
import { HttpsError, CallableRequest } from "firebase-functions/v2/https";

export type OrgRole = "org_owner" | "show_operator" | "content_editor" | "marketer" | "door_staff";

export const ORG_ROLES = new Set<OrgRole>([
  "org_owner",
  "show_operator",
  "content_editor",
  "marketer",
  "door_staff",
]);

export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function normalizeOrgRole(value: unknown): OrgRole | null {
  return typeof value === "string" && ORG_ROLES.has(value as OrgRole) ? value as OrgRole : null;
}

export function isPlatformAdmin(token: Record<string, unknown>): boolean {
  return token.platform_admin === true;
}

export function rolesFromValue(value: unknown): OrgRole[] {
  if (Array.isArray(value)) {
    return value.filter((role): role is OrgRole => ORG_ROLES.has(role as OrgRole));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .filter(([, enabled]) => enabled === true)
      .map(([role]) => role)
      .filter((role): role is OrgRole => ORG_ROLES.has(role as OrgRole));
  }
  return [];
}

export async function hasOrgRole(uid: string, orgId: string, roles: OrgRole[]): Promise<boolean> {
  const snapshot = await admin.database()
    .ref(`members/${uid}/org_roles/${orgId}`)
    .once("value");
  const data = asRecord(snapshot.val());
  if (data.status && data.status !== "active") {
    return false;
  }
  const grantedRoles = rolesFromValue(data.roles);
  return roles.some((role) => grantedRoles.includes(role));
}

export async function ensureOrganizationExists(orgId: string): Promise<void> {
  const snapshot = await admin.database().ref(`organizations/${orgId}`).once("value");
  if (!snapshot.exists()) {
    throw new HttpsError("not-found", "Organization does not exist.");
  }
  const data = asRecord(snapshot.val());
  if (data.status === "suspended") {
    throw new HttpsError("failed-precondition", "Organization is suspended.");
  }
}

export async function ensureCallerCanManageOrg(
  request: CallableRequest<unknown>,
  orgId: string,
  targetRole: OrgRole
): Promise<void> {
  const token = request.auth?.token ?? {};
  if (isPlatformAdmin(token)) {
    return;
  }

  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("permission-denied", "Authenticated uid required.");
  }

  const callerIsOwner = await hasOrgRole(callerUid, orgId, ["org_owner"]);
  if (callerIsOwner && targetRole !== "org_owner") {
    return;
  }

  throw new HttpsError(
    "permission-denied",
    "Only platform admins or this org's owner can manage org roles."
  );
}

export async function updateOrgOperatorClaims(uid: string): Promise<void> {
  const snapshot = await admin.database().ref(`members/${uid}/org_roles`).once("value");
  let hasAnyOperatorRole = false;
  let hasAnyOwnerRole = false;

  snapshot.forEach((child) => {
    const data = asRecord(child.val());
    if (data.status && data.status !== "active") {
      return false;
    }
    const roles = rolesFromValue(data.roles);
    if (roles.length > 0) {
      hasAnyOperatorRole = true;
    }
    if (roles.includes("org_owner")) {
      hasAnyOwnerRole = true;
    }
    return false;
  });

  const user = await admin.auth().getUser(uid);
  const claims = { ...(user.customClaims ?? {}) };
  if (hasAnyOperatorRole) {
    claims.org_operator = true;
  } else {
    delete claims.org_operator;
  }
  if (hasAnyOwnerRole) {
    claims.org_owner = true;
  } else {
    delete claims.org_owner;
  }
  await admin.auth().setCustomUserClaims(uid, claims);
}

export async function writeOrgAuditLog(params: {
  request: CallableRequest<unknown>;
  action: "grantOrganizationRole" | "revokeOrganizationRole";
  status: "success" | "denied" | "failed";
  details: Record<string, unknown>;
  reason?: string;
}): Promise<void> {
  await admin.database().ref("audit_log").push({
    actorUid: params.request.auth?.uid ?? null,
    actorEmail: params.request.auth?.token.email ?? null,
    action: params.action,
    status: params.status,
    reason: params.reason ?? null,
    details: params.details,
    at: ServerValue.TIMESTAMP,
  });
}
