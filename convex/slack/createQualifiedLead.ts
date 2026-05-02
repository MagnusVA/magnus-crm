import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { resolveLeadIdentity } from "../leads/identityResolution";
import { emitDomainEvent } from "../lib/domainEvents";
import { socialPlatformValidator } from "../lib/socialPlatform";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { upsertSlackUserOnSubmission } from "./users";

const SLACK_DEDUP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export const create = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    installationId: v.id("slackInstallations"),
    fullName: v.string(),
    platform: socialPlatformValidator,
    handle: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    qualifiedBy: v.object({
      slackUserId: v.string(),
      slackTeamId: v.string(),
      submittedAt: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const resolution = await resolveLeadIdentity(ctx, {
      tenantId: args.tenantId,
      email: args.email,
      socialHandle: { platform: args.platform, rawValue: args.handle },
      phone: args.phone,
      fullName: args.fullName,
      identifierSource: "slack_qualified",
      createIfMissing: true,
      createIdentifiers: true,
      createdAt: now,
    });

    await upsertSlackUserOnSubmission(ctx, {
      tenantId: args.tenantId,
      installationId: args.installationId,
      slackUserId: args.qualifiedBy.slackUserId,
      slackTeamId: args.qualifiedBy.slackTeamId,
      now,
    });

    const lookbackCutoff = now - SLACK_DEDUP_LOOKBACK_MS;
    const recent = await ctx.db
      .query("opportunities")
      .withIndex(
        "by_tenantId_and_leadId_and_source_and_status_and_createdAt",
        (q) =>
          q
            .eq("tenantId", args.tenantId)
            .eq("leadId", resolution.leadId)
            .eq("source", "slack_qualified")
            .eq("status", "qualified_pending")
            .gt("createdAt", lookbackCutoff),
      )
      .order("desc")
      .first();

    if (recent) {
      console.warn("[Slack:CreateQL] dedup hit", {
        tenantId: args.tenantId,
        leadId: resolution.leadId,
        existingOpportunityId: recent._id,
        priorSubmitter: recent.qualifiedBy?.slackUserId,
      });
      return {
        duplicate: true as const,
        existingOpportunityId: recent._id,
        priorQualifiedBy: recent.qualifiedBy ?? null,
      };
    }

    const existingOppsForLead = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", args.tenantId).eq("leadId", resolution.leadId),
      )
      .take(20);
    const alreadyBooked = existingOppsForLead.find(
      (opportunity) =>
        opportunity.status !== "lost" &&
        opportunity.status !== "canceled" &&
        opportunity.status !== "no_show",
    );
    if (alreadyBooked) {
      return {
        duplicate: true as const,
        existingOpportunityId: alreadyBooked._id,
        priorQualifiedBy: alreadyBooked.qualifiedBy ?? null,
        alreadyBooked: alreadyBooked.status !== "qualified_pending",
      };
    }

    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId: args.tenantId,
      leadId: resolution.leadId,
      status: "qualified_pending",
      source: "slack_qualified",
      qualifiedBy: args.qualifiedBy,
      createdAt: now,
      updatedAt: now,
      latestActivityAt: now,
    });

    await insertOpportunityAggregate(ctx, opportunityId);
    await updateTenantStats(ctx, args.tenantId, {
      totalOpportunities: 1,
      activeOpportunities: 1,
    });
    await emitDomainEvent(ctx, {
      tenantId: args.tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.created",
      source: "pipeline",
      toStatus: "qualified_pending",
      occurredAt: now,
      metadata: { source: "slack_qualified" },
    });

    await ctx.scheduler.runAfter(0, internal.slack.notify.postConfirmation, {
      tenantId: args.tenantId,
      opportunityId,
      leadId: resolution.leadId,
    });

    console.log("[Slack:CreateQL] opportunity inserted", {
      tenantId: args.tenantId,
      opportunityId,
      leadId: resolution.leadId,
      resolvedVia: resolution.resolvedVia,
    });

    return {
      duplicate: false as const,
      opportunityId,
      leadId: resolution.leadId,
      isNewLead: resolution.isNewLead,
      resolvedVia: resolution.resolvedVia,
    };
  },
});
