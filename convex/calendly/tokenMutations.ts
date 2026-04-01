import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

export const acquireRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants"), lockUntil: v.number() },
  handler: async (ctx, { tenantId, lockUntil }) => {
    await ctx.db.patch(tenantId, { calendlyRefreshLockUntil: lockUntil });
  },
});

export const releaseRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await ctx.db.patch(tenantId, { calendlyRefreshLockUntil: undefined });
  },
});

export const listActiveTenantIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .take(500);
    return tenants.map((t) => t._id);
  },
});
