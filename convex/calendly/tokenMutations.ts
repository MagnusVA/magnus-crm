import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import {
  getTenantCalendlyConnectionState,
  updateTenantCalendlyConnection,
} from "../lib/tenantCalendlyConnection";

export const acquireTokenRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants"), lockUntil: v.number() },
  handler: async (ctx, { tenantId, lockUntil }) => {
    console.log(
      `[token-refresh] acquireTokenRefreshLock: attempting for tenant ${tenantId}, lockUntil=${new Date(lockUntil).toISOString()}`,
    );
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      console.error(
        `[token-refresh] acquireTokenRefreshLock: tenant ${tenantId} not found`,
      );
      throw new Error("Tenant not found");
    }

    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);
    const now = Date.now();
    if (connection?.refreshLockUntil && connection.refreshLockUntil > now) {
      console.warn(
        `[token-refresh] acquireTokenRefreshLock: tenant ${tenantId} lock already held until ${new Date(connection.refreshLockUntil).toISOString()}`,
      );
      return {
        acquired: false as const,
        lockUntil: connection.refreshLockUntil,
      };
    }

    await updateTenantCalendlyConnection(ctx, tenantId, {
      refreshLockUntil: lockUntil,
    });
    console.log(
      `[token-refresh] acquireTokenRefreshLock: tenant ${tenantId} lock acquired`,
    );
    return { acquired: true as const, lockUntil };
  },
});

export const releaseTokenRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(
      `[token-refresh] releaseTokenRefreshLock: releasing for tenant ${tenantId}`,
    );
    await updateTenantCalendlyConnection(ctx, tenantId, {
      refreshLockUntil: undefined,
    });
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
