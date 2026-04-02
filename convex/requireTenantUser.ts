import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { CrmRole } from "./lib/roleMapping";
import { getIdentityOrgId } from "./lib/identity";

export type TenantUserResult = {
  userId: Id<"users">;
  tenantId: Id<"tenants">;
  role: CrmRole;
  workosUserId: string;
};

export async function requireTenantUser(
  ctx: QueryCtx | MutationCtx,
  allowedRoles: CrmRole[],
): Promise<TenantUserResult> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Not authenticated");
  }

  const orgId = getIdentityOrgId(identity);
  if (!orgId) {
    throw new Error("No organization context");
  }

  const workosUserId = identity.tokenIdentifier ?? identity.subject;
  if (!workosUserId) {
    throw new Error("Missing WorkOS user ID");
  }

  const user = await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
    .unique();

  if (!user) {
    throw new Error("User not found — please complete setup");
  }

  const tenant = await ctx.db.get(user.tenantId);
  if (!tenant || tenant.workosOrgId !== orgId) {
    throw new Error("Organization mismatch");
  }

  if (!allowedRoles.includes(user.role)) {
    throw new Error("Insufficient permissions");
  }

  return {
    userId: user._id,
    tenantId: user.tenantId,
    role: user.role,
    workosUserId,
  };
}
