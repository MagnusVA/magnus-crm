import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import {
  getTenantCalendlyConnectionState,
  updateTenantCalendlyConnection,
} from "../lib/tenantCalendlyConnection";

const PROVISIONING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export const listStuckProvisioningTenants = internalQuery({
  args: {},
  handler: async (ctx) => {
    console.log(`[health-check] listStuckProvisioningTenants: querying, timeout=${PROVISIONING_TIMEOUT_MS}ms`);
    const cutoff = Date.now() - PROVISIONING_TIMEOUT_MS;
    const stuck: Array<{ tenantId: Id<"tenants">; companyName: string }> = [];

    for await (const tenant of ctx.db
      .query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "provisioning_webhooks"))) {
      const connection = await getTenantCalendlyConnectionState(ctx, tenant._id);
      const startedAt =
        connection?.webhookProvisioningStartedAt ?? tenant._creationTime;
      if (startedAt >= cutoff) {
        continue;
      }

      stuck.push({
        tenantId: tenant._id,
        companyName: tenant.companyName,
      });

      if (stuck.length >= 100) {
        console.warn(`[health-check] listStuckProvisioningTenants: hit 100 stuck tenant limit`);
        break;
      }
    }

    console.log(`[health-check] listStuckProvisioningTenants: found ${stuck.length} stuck tenants`);
    return stuck;
  },
});

export const markTenantHealthChecked = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    checkedAt: v.number(),
  },
  handler: async (ctx, { tenantId, checkedAt }) => {
    await updateTenantCalendlyConnection(ctx, tenantId, {
      lastHealthCheckAt: checkedAt,
    });
  },
});
