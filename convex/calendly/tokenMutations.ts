import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";

export const acquireRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants"), lockUntil: v.number() },
  handler: async (ctx, { tenantId, lockUntil }) => {
    console.log(`[token-refresh] acquireRefreshLock: attempting for tenant ${tenantId}, lockUntil=${new Date(lockUntil).toISOString()}`);
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      console.error(`[token-refresh] acquireRefreshLock: tenant ${tenantId} not found`);
      throw new Error("Tenant not found");
    }

    const now = Date.now();
    if (
      tenant.calendlyRefreshLockUntil &&
      tenant.calendlyRefreshLockUntil > now
    ) {
      console.warn(`[token-refresh] acquireRefreshLock: tenant ${tenantId} lock already held until ${new Date(tenant.calendlyRefreshLockUntil).toISOString()}`);
      return { acquired: false as const, lockUntil: tenant.calendlyRefreshLockUntil };
    }

    await ctx.db.patch(tenantId, { calendlyRefreshLockUntil: lockUntil });
    console.log(`[token-refresh] acquireRefreshLock: tenant ${tenantId} lock acquired`);
    return { acquired: true as const, lockUntil };
  },
});

export const releaseRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(`[token-refresh] releaseRefreshLock: releasing for tenant ${tenantId}`);
    await ctx.db.patch(tenantId, { calendlyRefreshLockUntil: undefined });
  },
});

export const listActiveTenantIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    console.log(`[token-refresh] listActiveTenantIds: querying active tenants`);
    const tenantIds: Array<Id<"tenants">> = [];
    for await (const tenant of ctx.db
      .query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "active"))) {
      tenantIds.push(tenant._id);
    }

    console.log(`[token-refresh] listActiveTenantIds: found ${tenantIds.length} active tenants`);
    return tenantIds;
  },
});
