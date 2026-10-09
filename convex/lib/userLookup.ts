import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { rejectRequest } from "./observability/errors";
import type { CrmRole } from "./roleMapping";

export const resolveCrmUserByIdentity = internalQuery({
  args: {
    workosUserIdCandidates: v.array(v.string()),
    orgId: v.string(),
    subjectFallback: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let user = null;
    for (const candidate of args.workosUserIdCandidates) {
      user = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", candidate))
        .unique();
      if (user) {
        break;
      }
    }

    if (
      !user &&
      args.subjectFallback &&
      !args.workosUserIdCandidates.includes(args.subjectFallback)
    ) {
      user = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) =>
          q.eq("workosUserId", args.subjectFallback!),
        )
        .unique();
    }

    if (!user) {
      throw rejectRequest(
        "auth.user_not_found",
        "User not found — please complete setup",
        { orgId: args.orgId },
      );
    }
    if (user.isActive === false) {
      throw rejectRequest("auth.user_inactive", "User account is inactive", {
        userId: user._id,
        tenantId: user.tenantId,
      });
    }

    const tenant = await ctx.db.get("tenants", user.tenantId);
    if (!tenant || tenant.workosOrgId !== args.orgId) {
      throw rejectRequest("auth.organization_mismatch", "Organization mismatch", {
        userId: user._id,
        tenantId: user.tenantId,
        orgId: args.orgId,
        tenantOrgId: tenant?.workosOrgId ?? null,
      });
    }

    return {
      userId: user._id,
      tenantId: user.tenantId,
      role: user.role as CrmRole,
      workosUserId: user.workosUserId,
    };
  },
});
