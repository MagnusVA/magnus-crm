import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const insertCopyEvent = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    sessionVersion: v.number(),
    sessionIdHash: v.string(),
    eventTypeConfigId: v.id("eventTypeConfigs"),
    dmCloserId: v.id("dmClosers"),
    campaignPresetId: v.id("linkPortalCampaignPresets"),
  },
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("linkPortalConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .unique();
    if (
      !config ||
      !config.isEnabled ||
      config.publicSlug !== args.publicSlug ||
      config.sessionVersion !== args.sessionVersion
    ) {
      throw new Error("Portal session is no longer valid.");
    }

    const [eventTypeConfig, dmCloser, campaign] = await Promise.all([
      ctx.db.get(args.eventTypeConfigId),
      ctx.db.get(args.dmCloserId),
      ctx.db.get(args.campaignPresetId),
    ]);

    if (
      !eventTypeConfig ||
      eventTypeConfig.tenantId !== args.tenantId ||
      eventTypeConfig.linkPortalEnabled !== true ||
      !eventTypeConfig.bookingBaseUrl ||
      !eventTypeConfig.bookingProgramId ||
      eventTypeConfig.bookingProgramMappingStatus !== "mapped"
    ) {
      throw new Error("Portal event type is not available.");
    }

    const bookingProgram = await ctx.db.get(eventTypeConfig.bookingProgramId);
    if (
      !bookingProgram ||
      bookingProgram.tenantId !== args.tenantId ||
      bookingProgram.archivedAt !== undefined
    ) {
      throw new Error("Portal event type is not available.");
    }

    if (!dmCloser || dmCloser.tenantId !== args.tenantId || !dmCloser.isActive) {
      throw new Error("DM closer is not available.");
    }

    const team = await ctx.db.get(dmCloser.teamId);
    if (!team || team.tenantId !== args.tenantId || !team.isActive) {
      throw new Error("Attribution team is not available.");
    }

    if (!campaign || campaign.tenantId !== args.tenantId || !campaign.isActive) {
      throw new Error("Campaign preset is not available.");
    }

    return await ctx.db.insert("linkPortalCopyEvents", {
      tenantId: args.tenantId,
      sessionIdHash: args.sessionIdHash,
      eventTypeConfigId: eventTypeConfig._id,
      bookingProgramId: bookingProgram._id,
      attributionTeamId: team._id,
      dmCloserId: dmCloser._id,
      campaignPresetId: campaign._id,
      utmCampaign: campaign.utmCampaign,
      copiedAt: Date.now(),
    });
  },
});
