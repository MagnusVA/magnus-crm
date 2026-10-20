import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { canTeamUseEventType } from "../lib/attribution/teamEventTypeRoutes";
import { isPortalBookable } from "../lib/eventTypeBookability";
import { log } from "../lib/observability/log";

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
      log.warn("link_portal.session.rejected", {
        reason: !config
          ? "portal_not_found"
          : !config.isEnabled
            ? "portal_disabled"
            : config.publicSlug !== args.publicSlug
              ? "slug_rotated"
              : "session_version_stale",
        tenantId: args.tenantId,
        sessionVersion: args.sessionVersion,
      });
      throw new Error("Portal session is no longer valid.");
    }

    const [eventTypeConfig, dmCloser, campaign] = await Promise.all([
      ctx.db.get("eventTypeConfigs", args.eventTypeConfigId),
      ctx.db.get("dmClosers", args.dmCloserId),
      ctx.db.get("linkPortalCampaignPresets", args.campaignPresetId),
    ]);

    if (
      !eventTypeConfig ||
      eventTypeConfig.tenantId !== args.tenantId ||
      !isPortalBookable(eventTypeConfig)
    ) {
      throw new Error("Portal event type is not available.");
    }

    const bookingProgramId = eventTypeConfig.bookingProgramId;
    if (!bookingProgramId) {
      throw new Error("Portal event type is not available.");
    }

    const bookingProgram = await ctx.db.get("tenantPrograms", bookingProgramId);
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

    const team = await ctx.db.get("attributionTeams", dmCloser.teamId);
    if (!team || team.tenantId !== args.tenantId || !team.isActive) {
      throw new Error("Attribution team is not available.");
    }

    if (
      !(await canTeamUseEventType(ctx, {
        tenantId: args.tenantId,
        teamId: team._id,
        eventTypeConfig,
      }))
    ) {
      log.warn("link_portal.copy.team_event_type_rejected", {
        tenantId: args.tenantId,
        teamId: team._id,
        eventTypeConfigId: eventTypeConfig._id,
      });
      throw new Error("Portal event type is not available for this team.");
    }

    if (!campaign || campaign.tenantId !== args.tenantId || !campaign.isActive) {
      throw new Error("Campaign preset is not available.");
    }

    return await ctx.db.insert("linkPortalCopyEvents", {
      tenantId: args.tenantId,
      sessionIdHash: args.sessionIdHash,
      eventTypeConfigId: eventTypeConfig._id,
      bookingProgramId,
      attributionTeamId: team._id,
      dmCloserId: dmCloser._id,
      campaignPresetId: campaign._id,
      utmCampaign: campaign.utmCampaign,
      copiedAt: Date.now(),
    });
  },
});
