import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import {
  getTenantCalendlyConnectionState,
  updateTenantCalendlyConnection,
} from "../lib/tenantCalendlyConnection";
import { log } from "../lib/observability/log";

export const acquireTokenRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants"), lockUntil: v.number() },
  handler: async (ctx, { tenantId, lockUntil }) => {
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) {
      log.warn("calendly.token.rejected", {
        reason: "tenant_not_found",
        operation: "acquire_refresh_lock",
        tenantId,
      });
      throw new Error("Tenant not found");
    }

    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);
    const now = Date.now();
    if (connection?.refreshLockUntil && connection.refreshLockUntil > now) {
      // refreshTenantTokenCore logs this as `lock_held` with `lockRace`.
      return {
        acquired: false as const,
        lockUntil: connection.refreshLockUntil,
      };
    }

    await updateTenantCalendlyConnection(ctx, tenantId, {
      refreshLockUntil: lockUntil,
    });
    return { acquired: true as const, lockUntil };
  },
});

export const releaseTokenRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await updateTenantCalendlyConnection(ctx, tenantId, {
      refreshLockUntil: undefined,
    });
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
