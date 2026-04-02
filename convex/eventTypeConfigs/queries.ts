import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * List all event type configs for the current tenant.
 */
export const listEventTypeConfigs = query({
  args: {},
  handler: async (ctx) => {
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

    return configs;
  },
});
