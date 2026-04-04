import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getById = internalQuery({
  args: { eventTypeConfigId: v.id("eventTypeConfigs") },
  handler: async (ctx, { eventTypeConfigId }) => {
    console.log("[EventTypeConfig] getById called", { eventTypeConfigId });
    const config = await ctx.db.get(eventTypeConfigId);
    console.log("[EventTypeConfig] getById result", { found: !!config });
    return config;
  },
});

/**
 * List all event type configs for the current tenant.
 */
export const listEventTypeConfigs = query({
  args: {},
  handler: async (ctx) => {
    console.log("[EventTypeConfig] listEventTypeConfigs called");
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const configs = [];
    for await (const config of ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      configs.push(config);
    }

    console.log("[EventTypeConfig] listEventTypeConfigs result", { count: configs.length });
    return configs;
  },
});
