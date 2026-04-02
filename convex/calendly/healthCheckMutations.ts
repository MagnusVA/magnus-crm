import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";

const PROVISIONING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export const listStuckProvisioningTenants = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PROVISIONING_TIMEOUT_MS;
    const stuck: Array<{ tenantId: Id<"tenants">; companyName: string }> = [];

    for await (const tenant of ctx.db
      .query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "provisioning_webhooks"))) {
      const startedAt =
        tenant.webhookProvisioningStartedAt ?? tenant._creationTime;
      if (startedAt >= cutoff) {
        continue;
      }

      stuck.push({
        tenantId: tenant._id,
        companyName: tenant.companyName,
      });

      if (stuck.length >= 100) {
        break;
      }
    }

    return stuck;
  },
});
