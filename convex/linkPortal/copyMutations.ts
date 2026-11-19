import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { buildCloserLinkUrl, closerCalendarUrl, isLinkCode } from "../lib/closerLinks";
import { isInPortal, readCloserLinkState } from "../lib/closerLinkData";
import { isActiveLogin } from "../lib/teamMembers";
import { canTeamUseEventType } from "../lib/attribution/teamEventTypeRoutes";
import { isPortalBookable } from "../lib/eventTypeBookability";
import { linkIssue } from "../lib/bookingSetup/coverage";
import {
  canTeamLinkEventType,
  isCoverageMigrated,
} from "../lib/bookingSetup/coverageData";
import { expectedError } from "../lib/observability/errors";
import { log } from "../lib/observability/log";

// The same limits as portal notes and edits (leadMutations.ts): per DM
// closer per minute, plus a tenant-wide flood guard.
const COPY_RATE_WINDOW_MS = 60_000;
const COPY_RATE_MAX_PER_DM_CLOSER = 10;
const COPY_RATE_TENANT_FLOOD_LIMIT = 50;

/** The portal session still holds: the portal is on, at this path, at this session version. */
async function assertPortalSession(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; publicSlug: string; sessionVersion: number },
) {
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
}

/** The DM setter copying a link, their active team and the campaign. */
async function loadCopyContext(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    dmCloserId: Id<"dmClosers">;
    campaignPresetId: Id<"linkPortalCampaignPresets">;
  },
) {
  const [dmCloser, campaign] = await Promise.all([
    ctx.db.get("dmClosers", args.dmCloserId),
    ctx.db.get("linkPortalCampaignPresets", args.campaignPresetId),
  ]);
  if (!dmCloser || dmCloser.tenantId !== args.tenantId || !dmCloser.isActive) {
    throw new Error("DM closer is not available.");
  }
  const team = await ctx.db.get("attributionTeams", dmCloser.teamId);
  if (!team || team.tenantId !== args.tenantId || !team.isActive) {
    throw new Error("Attribution team is not available.");
  }
  if (!campaign || campaign.tenantId !== args.tenantId || !campaign.isActive) {
    throw new Error("Campaign preset is not available.");
  }
  return { dmCloser, team, campaign };
}

/** Per DM closer per minute, plus a tenant-wide flood guard. Throws when over. */
async function assertCopyRateLimit(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; dmCloserId: Id<"dmClosers">; sessionIdHash: string },
) {
    const now = Date.now();
    const recentCopies = await ctx.db
      .query("linkPortalCopyEvents")
      .withIndex("by_tenantId_and_copiedAt", (q) =>
        q.eq("tenantId", args.tenantId).gte("copiedAt", now - COPY_RATE_WINDOW_MS).lte("copiedAt", now),
      )
      .order("desc")
      .take(COPY_RATE_TENANT_FLOOD_LIMIT);
    const dmCloserRecentCount = recentCopies.filter((copy) => copy.dmCloserId === args.dmCloserId).length;
    if (
      dmCloserRecentCount >= COPY_RATE_MAX_PER_DM_CLOSER ||
      recentCopies.length >= COPY_RATE_TENANT_FLOOD_LIMIT
    ) {
      log.warn("link_portal.copy.rate_limited", {
        reason: recentCopies.length >= COPY_RATE_TENANT_FLOOD_LIMIT ? "tenant_flood" : "dm_closer_limit",
        tenantId: args.tenantId,
        dmCloserId: args.dmCloserId,
        sessionIdHash: args.sessionIdHash,
        dmCloserRecentCount,
        tenantRecentCount: recentCopies.length,
      });
      throw expectedError("link_portal.copy_rate_limited", "Too many links in a short time. Try again in a minute.");
    }
    return now;
}

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
    await assertPortalSession(ctx, args);

    const [tenant, eventTypeConfig, dmCloser, campaign] = await Promise.all([
      ctx.db.get("tenants", args.tenantId),
      ctx.db.get("eventTypeConfigs", args.eventTypeConfigId),
      ctx.db.get("dmClosers", args.dmCloserId),
      ctx.db.get("linkPortalCampaignPresets", args.campaignPresetId),
    ]);
    const onCoverage = tenant !== null && isCoverageMigrated(tenant);

    if (
      !eventTypeConfig ||
      eventTypeConfig.tenantId !== args.tenantId ||
      // On booking coverage a cell publishes the event type; the team check
      // below decides. linkPortalEnabled is the legacy switch.
      (onCoverage
        ? linkIssue(eventTypeConfig) !== null ||
          eventTypeConfig.bookingProgramMappingStatus !== "mapped"
        : !isPortalBookable(eventTypeConfig))
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

    const teamCanUse = onCoverage
      ? await canTeamLinkEventType(ctx, {
          tenantId: args.tenantId,
          team,
          eventTypeConfig,
        })
      : await canTeamUseEventType(ctx, {
          tenantId: args.tenantId,
          teamId: team._id,
          eventTypeConfig,
        });
    if (!teamCanUse) {
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

    const now = await assertCopyRateLimit(ctx, {
      tenantId: args.tenantId,
      dmCloserId: dmCloser._id,
      sessionIdHash: args.sessionIdHash,
    });

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

/**
 * A closer link copied in the DM portal: checks everything the link depends
 * on, logs the copy, and returns the link. The portal copies only what this
 * returns, so a closer switched off or deactivated after the page loaded
 * can't be copied from a stale page.
 */
export const insertCloserLinkCopy = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    sessionVersion: v.number(),
    sessionIdHash: v.string(),
    phoneCloserUserId: v.id("users"),
    programId: v.id("tenantPrograms"),
    dmCloserId: v.id("dmClosers"),
    campaignPresetId: v.id("linkPortalCampaignPresets"),
  },
  handler: async (ctx, args) => {
    await assertPortalSession(ctx, args);
    const { dmCloser, team, campaign } = await loadCopyContext(ctx, args);

    const phoneCloser = await ctx.db.get("users", args.phoneCloserUserId);
    if (
      !phoneCloser ||
      phoneCloser.tenantId !== args.tenantId ||
      phoneCloser.role !== "closer" ||
      !isActiveLogin(phoneCloser)
    ) {
      throw expectedError("link_portal.closer_unavailable", "This closer is no longer available.");
    }
    const state = await readCloserLinkState(ctx, phoneCloser);
    const calendarUrl = state.config ? closerCalendarUrl(state.config) : undefined;
    if (!isInPortal(phoneCloser, state) || !state.config || !calendarUrl) {
      log.warn("link_portal.closer_link.rejected", {
        tenantId: args.tenantId,
        phoneCloserUserId: phoneCloser._id,
        status: state.status,
        inPortal: phoneCloser.closerLinkInPortalAt !== undefined,
      });
      throw expectedError("link_portal.closer_unavailable", "This closer is no longer available.");
    }

    const program = await ctx.db.get("tenantPrograms", args.programId);
    if (
      !program ||
      program.tenantId !== args.tenantId ||
      program.archivedAt !== undefined ||
      !program.linkCode ||
      !isLinkCode(program.linkCode)
    ) {
      throw expectedError("link_portal.program_unavailable", "This program is no longer available.");
    }

    const now = await assertCopyRateLimit(ctx, {
      tenantId: args.tenantId,
      dmCloserId: dmCloser._id,
      sessionIdHash: args.sessionIdHash,
    });

    const url = buildCloserLinkUrl({
      calendarUrl,
      teamUtmSource: team.utmSource,
      dmCloserUtmMedium: dmCloser.utmMedium,
      utmCampaign: campaign.utmCampaign,
      programLinkCode: program.linkCode,
    });
    const copyEventId = await ctx.db.insert("linkPortalCopyEvents", {
      tenantId: args.tenantId,
      sessionIdHash: args.sessionIdHash,
      eventTypeConfigId: state.config._id,
      bookingProgramId: program._id,
      attributionTeamId: team._id,
      dmCloserId: dmCloser._id,
      campaignPresetId: campaign._id,
      utmCampaign: campaign.utmCampaign,
      copiedAt: now,
      linkHostUserId: phoneCloser._id,
    });
    return { copyEventId, url };
  },
});
