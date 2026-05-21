import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getPortalConfigForSettings = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const config = await ctx.db
      .query("linkPortalConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();

    return config
      ? {
          publicSlug: config.publicSlug,
          isEnabled: config.isEnabled,
          sessionTtlSeconds: config.sessionTtlSeconds,
          passwordSetAt: config.passwordSetAt,
          passwordRotatedAt: config.passwordRotatedAt,
          updatedAt: config.updatedAt,
        }
      : null;
  },
});

export const getConfigByPublicSlug = internalQuery({
  args: { publicSlug: v.string() },
  handler: async (ctx, { publicSlug }) => {
    return await ctx.db
      .query("linkPortalConfigs")
      .withIndex("by_publicSlug", (q) => q.eq("publicSlug", publicSlug))
      .unique();
  },
});
