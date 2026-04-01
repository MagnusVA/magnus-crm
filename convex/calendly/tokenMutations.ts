import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const storeCalendlyTokens = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyAccessToken: v.string(),
    calendlyRefreshToken: v.string(),
    calendlyTokenExpiresAt: v.number(),
    calendlyOrgUri: v.string(),
    calendlyOwnerUri: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.tenantId, {
      calendlyAccessToken: args.calendlyAccessToken,
      calendlyRefreshToken: args.calendlyRefreshToken,
      calendlyTokenExpiresAt: args.calendlyTokenExpiresAt,
      calendlyOrgUri: args.calendlyOrgUri,
      calendlyOwnerUri: args.calendlyOwnerUri,
    });
  },
});
