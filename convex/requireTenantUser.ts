import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { CrmRole } from "./lib/roleMapping";
import { getIdentityOrgId } from "./lib/identity";
import { expectedError, rejectRequest } from "./lib/observability/errors";
import { logRequestContext } from "./lib/observability/log";
import {
  getCanonicalIdentityWorkosUserId,
  getRawWorkosUserId,
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
  // Queries re-run on every subscription update, so a rejected query skips
  // the `request.rejected` line; the ingest reads the code from the error.
  const reject: typeof rejectRequest =
    "scheduler" in ctx
      ? rejectRequest
      : (code, message) => expectedError(code, message);

  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw reject("auth.not_authenticated", "Not authenticated");
  }

  const orgId = getIdentityOrgId(identity);
  if (!orgId) {
    throw reject("auth.no_organization", "No organization context", {
      subject: identity.subject,
    });
  }

  const workosUserId = getCanonicalIdentityWorkosUserId(identity);
  if (!workosUserId) {
    throw reject("auth.missing_workos_user_id", "Missing WorkOS user ID", {
      orgId,
    });
  }

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
    let subjectMatchFound = false;
    if (identity.subject && identity.subject !== workosUserId) {
      const subjectMatch = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", identity.subject))
        .unique();
      subjectMatchFound = Boolean(subjectMatch);
    }

    throw reject(
      "auth.user_not_found",
      "User not found — please complete setup",
      {
        workosUserId,
        subject: identity.subject,
        subjectMatchFound,
        orgId,
      },
    );
  }

  const context = {
    distinctId: getRawWorkosUserId(workosUserId),
    userId: user._id,
    tenantId: user.tenantId,
    workosOrgId: orgId,
    role: user.role,
  };

  if (user.isActive === false) {
    throw reject("auth.user_inactive", "User account is inactive", context);
  }

  const tenant = await ctx.db.get("tenants", user.tenantId);
  if (!tenant || tenant.workosOrgId !== orgId) {
    throw reject("auth.organization_mismatch", "Organization mismatch", {
      ...context,
      tenantFound: Boolean(tenant),
      tenantOrgId: tenant?.workosOrgId ?? null,
    });
  }

  logRequestContext(context);

  if (!allowedRoles.includes(user.role)) {
    throw reject("auth.insufficient_permissions", "Insufficient permissions", {
      ...context,
      allowedRoles,
    });
  }

  return {
    userId: user._id,
    tenantId: user.tenantId,
    role: user.role,
    workosUserId,
  };
}
