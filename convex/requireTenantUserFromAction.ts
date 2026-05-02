import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { getIdentityOrgId } from "./lib/identity";
import type { CrmRole } from "./lib/roleMapping";
import {
  getCanonicalIdentityWorkosUserId,
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
  console.log("[Auth:Action] requireTenantUserFromAction called", {
    allowedRoles,
  });

  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    console.error("[Auth:Action] failed: no identity");
    throw new Error("Not authenticated");
  }

  const orgId = getIdentityOrgId(identity);
  if (!orgId) {
    console.error("[Auth:Action] failed: no orgId from identity");
    throw new Error("No organization context");
  }

  const workosUserId = getCanonicalIdentityWorkosUserId(identity);
  if (!workosUserId) {
    console.error("[Auth:Action] failed: no workosUserId");
    throw new Error("Missing WorkOS user ID");
  }

  const resolved = await ctx.runQuery(
    internal.lib.userLookup.resolveCrmUserByIdentity,
    {
      workosUserIdCandidates: getWorkosUserIdCandidates(workosUserId),
      orgId,
      subjectFallback: identity.subject ?? undefined,
    },
  );

  if (!allowedRoles.includes(resolved.role)) {
    console.error("[Auth:Action] failed: insufficient permissions", {
      userRole: resolved.role,
      allowedRoles,
    });
    throw new Error("Insufficient permissions");
  }

  console.log("[Auth:Action] succeeded", {
    userId: resolved.userId,
    tenantId: resolved.tenantId,
    role: resolved.role,
  });

  return resolved;
}
