import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";

export const acquireRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants"), lockUntil: v.number() },
  handler: async (ctx, { tenantId, lockUntil }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const now = Date.now();
    if (
      tenant.calendlyRefreshLockUntil &&
      tenant.calendlyRefreshLockUntil > now
    ) {
      return { acquired: false as const, lockUntil: tenant.calendlyRefreshLockUntil };
    }

    await ctx.db.patch(tenantId, { calendlyRefreshLockUntil: lockUntil });
    return { acquired: true as const, lockUntil };
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
    const tenantIds: Array<Id<"tenants">> = [];
    for await (const tenant of ctx.db
      .query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "active"))) {
      tenantIds.push(tenant._id);
    }

    return tenantIds;
  },
});
