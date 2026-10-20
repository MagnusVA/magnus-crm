import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { canTeamUseEventType } from "../lib/attribution/teamEventTypeRoutes";
import { isPortalBookable } from "../lib/eventTypeBookability";
import { expectedError } from "../lib/observability/errors";
import { log } from "../lib/observability/log";

// The same limits as portal notes and edits (leadMutations.ts): per DM
// closer per minute, plus a tenant-wide flood guard.
const COPY_RATE_WINDOW_MS = 60_000;
const COPY_RATE_MAX_PER_DM_CLOSER = 10;
const COPY_RATE_TENANT_FLOOD_LIMIT = 50;

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

    const now = Date.now();
    const recentCopies = await ctx.db
      .query("linkPortalCopyEvents")
      .withIndex("by_tenantId_and_copiedAt", (q) =>
        q.eq("tenantId", args.tenantId).gte("copiedAt", now - COPY_RATE_WINDOW_MS).lte("copiedAt", now),
      )
      .order("desc")
      .take(COPY_RATE_TENANT_FLOOD_LIMIT);
    const dmCloserRecentCount = recentCopies.filter((copy) => copy.dmCloserId === dmCloser._id).length;
    if (
      dmCloserRecentCount >= COPY_RATE_MAX_PER_DM_CLOSER ||
      recentCopies.length >= COPY_RATE_TENANT_FLOOD_LIMIT
    ) {
      log.warn("link_portal.copy.rate_limited", {
        reason: recentCopies.length >= COPY_RATE_TENANT_FLOOD_LIMIT ? "tenant_flood" : "dm_closer_limit",
        tenantId: args.tenantId,
        dmCloserId: dmCloser._id,
        sessionIdHash: args.sessionIdHash,
        dmCloserRecentCount,
        tenantRecentCount: recentCopies.length,
      });
      throw expectedError("link_portal.copy_rate_limited", "Too many links in a short time. Try again in a minute.");
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
      copiedAt: now,
    });
  },
});
