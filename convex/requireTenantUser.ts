import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { CrmRole } from "./lib/roleMapping";
import { getIdentityOrgId } from "./lib/identity";
import {
  getCanonicalIdentityWorkosUserId,
  getWorkosUserIdCandidates,
} from "./lib/workosUserId";

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
  console.log("[Auth] requireTenantUser called", { allowedRoles });

  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    console.error("[Auth] requireTenantUser failed: no identity");
    throw new Error("Not authenticated");
  }
  console.log("[Auth] identity resolved", {
    subject: identity.subject,
    tokenIdentifier: identity.tokenIdentifier ?? null,
  });

  const orgId = getIdentityOrgId(identity);
  if (!orgId) {
    console.error("[Auth] requireTenantUser failed: no orgId from identity");
    throw new Error("No organization context");
  }
  console.log("[Auth] orgId resolved", { orgId });

  const workosUserId = getCanonicalIdentityWorkosUserId(identity);
  if (!workosUserId) {
    console.error("[Auth] requireTenantUser failed: no workosUserId");
    throw new Error("Missing WorkOS user ID");
  }
  console.log("[Auth] workosUserId resolved", { workosUserId });

  let user = null;
  for (const candidateWorkosUserId of getWorkosUserIdCandidates(workosUserId)) {
    user = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", candidateWorkosUserId))
      .unique();
    if (user) {
      break;
    }
  }

  if (!user) {
    if (identity.subject && identity.subject !== workosUserId) {
      const subjectMatch = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", identity.subject))
        .unique();

      console.error("[Auth] requireTenantUser alternate subject lookup", {
        chosenLookupKey: workosUserId,
        subject: identity.subject,
        tokenIdentifier: identity.tokenIdentifier ?? null,
        subjectMatchFound: Boolean(subjectMatch),
        subjectMatchUserId: subjectMatch?._id ?? null,
      });
    }

    console.error("[Auth] requireTenantUser failed: user not found", { workosUserId });
    throw new Error("User not found — please complete setup");
  }
  console.log("[Auth] user found", {
    userId: user._id,
    tenantId: user.tenantId,
    role: user.role,
  });

  const tenant = await ctx.db.get(user.tenantId);
  if (!tenant || tenant.workosOrgId !== orgId) {
    console.error("[Auth] requireTenantUser failed: org mismatch", {
      userTenantId: user.tenantId,
      tenantFound: Boolean(tenant),
      tenantOrgId: tenant?.workosOrgId ?? null,
      expectedOrgId: orgId,
    });
    throw new Error("Organization mismatch");
  }
  console.log("[Auth] tenant verified", { tenantId: tenant._id, orgId });

  if (!allowedRoles.includes(user.role)) {
    console.error("[Auth] requireTenantUser failed: insufficient permissions", {
      userRole: user.role,
      allowedRoles,
    });
    throw new Error("Insufficient permissions");
  }

  const result = {
    userId: user._id,
    tenantId: user.tenantId,
    role: user.role,
    workosUserId,
  };
  console.log("[Auth] requireTenantUser succeeded", {
    userId: result.userId,
    tenantId: result.tenantId,
    role: result.role,
  });
  return result;
}
