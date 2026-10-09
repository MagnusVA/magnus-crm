import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { getIdentityOrgId } from "./lib/identity";
import type { CrmRole } from "./lib/roleMapping";
import { rejectRequest } from "./lib/observability/errors";
import { logRequestContext } from "./lib/observability/log";
import {
  getCanonicalIdentityWorkosUserId,
  getRawWorkosUserId,
  getWorkosUserIdCandidates,
} from "./lib/workosUserId";

export type TenantUserFromActionResult = {
  userId: Id<"users">;
  tenantId: Id<"tenants">;
  role: CrmRole;
  workosUserId: string;
};

export async function requireTenantUserFromAction(
  ctx: ActionCtx,
  allowedRoles: CrmRole[],
): Promise<TenantUserFromActionResult> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw rejectRequest("auth.not_authenticated", "Not authenticated");
  }

  const orgId = getIdentityOrgId(identity);
  if (!orgId) {
    throw rejectRequest("auth.no_organization", "No organization context", {
      subject: identity.subject,
    });
  }

  const workosUserId = getCanonicalIdentityWorkosUserId(identity);
  if (!workosUserId) {
    throw rejectRequest("auth.missing_workos_user_id", "Missing WorkOS user ID", {
      orgId,
    });
  }

  const resolved = await ctx.runQuery(
    internal.lib.userLookup.resolveCrmUserByIdentity,
    {
      workosUserIdCandidates: getWorkosUserIdCandidates(workosUserId),
      orgId,
      subjectFallback: identity.subject ?? undefined,
    },
  );

  const context = {
    distinctId: getRawWorkosUserId(workosUserId),
    userId: resolved.userId,
    tenantId: resolved.tenantId,
    workosOrgId: orgId,
    role: resolved.role,
  };
  logRequestContext(context);

  if (!allowedRoles.includes(resolved.role)) {
    throw rejectRequest("auth.insufficient_permissions", "Insufficient permissions", {
      ...context,
      allowedRoles,
    });
  }

  return resolved;
}
