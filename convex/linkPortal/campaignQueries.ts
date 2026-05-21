import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const listCampaignPresetsForSettings = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const presets = await ctx.db
      .query("linkPortalCampaignPresets")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(100);
    return presets.sort((left, right) => left.sortOrder - right.sortOrder);
  },
});
