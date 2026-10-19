import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { canTeamUseEventType } from "../lib/attribution/teamEventTypeRoutes";
import { emitDomainEvent } from "../lib/domainEvents";
import { isPortalBookable } from "../lib/eventTypeBookability";
import { normalizeSocialHandle } from "../lib/normalization";
import { expectedError } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import { resolveLeadIdentity } from "../leads/identityResolution";
import { blockedReason } from "../pipeline/blocked";
import { PORTAL_LINK_COPIED, recordPortalTouch } from "./portalTouches";

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
    // The person the link is for (docs/plans/phase-2-person-first.md §4.3).
    instagramHandle: v.string(),
  },
  returns: v.object({
    copyEventId: v.id("linkPortalCopyEvents"),
    leadId: v.id("leads"),
  }),
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

    const handle = normalizeSocialHandle(args.instagramHandle, "instagram");
    if (!handle) {
      throw expectedError("link_portal.copy.invalid_handle", "Enter the person's Instagram handle.");
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

    // The person the link is for: found by handle, or created at In
    // conversation, since the DM closer is talking to them.
    let person;
    try {
      person = await resolveLeadIdentity(ctx, {
        tenantId: args.tenantId,
        socialHandle: { platform: "instagram", rawValue: handle },
        identifierSource: "dm_portal",
        createdAt: now,
        createIdentifiers: true,
        initialLifecycle: { stage: "in_conversation", at: now },
      });
    } catch (error) {
      if (!blockedReason(error)) {
        throw error;
      }
      throw expectedError(
        "link_portal.copy.identity_conflict",
        "This handle belongs to more than one person in the CRM. Ask an admin to merge them.",
      );
    }
    if (person.isNewLead) {
      await emitDomainEvent(ctx, {
        tenantId: args.tenantId,
        entityType: "lead",
        entityId: person.leadId,
        eventType: "lead.created",
        source: "pipeline",
        teamMemberId: dmCloser.teamMemberId,
        toStatus: "active",
        occurredAt: now,
      });
    }

    const copyEventId = await ctx.db.insert("linkPortalCopyEvents", {
      tenantId: args.tenantId,
      sessionIdHash: args.sessionIdHash,
      eventTypeConfigId: eventTypeConfig._id,
      bookingProgramId,
      attributionTeamId: team._id,
      dmCloserId: dmCloser._id,
      campaignPresetId: campaign._id,
      utmCampaign: campaign.utmCampaign,
      copiedAt: now,
      leadId: person.leadId,
    });
    await recordPortalTouch(ctx, {
      tenantId: args.tenantId,
      leadId: person.leadId,
      dmCloser,
      eventType: PORTAL_LINK_COPIED,
      at: now,
      metadata: {
        copyEventId,
        eventTypeConfigId: eventTypeConfig._id,
        campaignPresetId: campaign._id,
        utmCampaign: campaign.utmCampaign,
      },
    });

    return { copyEventId, leadId: person.leadId };
  },
});
