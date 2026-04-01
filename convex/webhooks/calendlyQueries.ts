import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const getTenantSigningKey = internalQuery({
  args: { tenantId: v.string() },
  handler: async (ctx, { tenantId }) => {
    const normalizedTenantId = ctx.db.normalizeId("tenants", tenantId);
    if (!normalizedTenantId) {
      return null;
    }

    const tenant = await ctx.db.get(normalizedTenantId);
    if (!tenant?.webhookSigningKey) {
      return null;
    }

    return {
      tenantId: normalizedTenantId,
      webhookSigningKey: tenant.webhookSigningKey,
    };
  },
});
