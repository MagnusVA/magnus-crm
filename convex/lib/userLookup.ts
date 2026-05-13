import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
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
      throw new Error("User not found — please complete setup");
    }
    if (user.isActive === false) {
      throw new Error("User account is inactive");
    }

    const tenant = await ctx.db.get(user.tenantId);
    if (!tenant || tenant.workosOrgId !== args.orgId) {
      throw new Error("Organization mismatch");
    }

    return {
      userId: user._id,
      tenantId: user.tenantId,
      role: user.role as CrmRole,
      workosUserId: user.workosUserId,
    };
  },
});
