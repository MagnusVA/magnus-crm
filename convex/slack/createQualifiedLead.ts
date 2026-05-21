import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { resolveLeadIdentity } from "../leads/identityResolution";
import { emitDomainEvent } from "../lib/domainEvents";
import { socialPlatformValidator, type SocialPlatform } from "../lib/socialPlatform";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { rebuildQualificationRow } from "../operations/projections";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { upsertSlackUserOnSubmission } from "./users";

const SLACK_DEDUP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

async function insertQualificationEvent(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    installationId: Id<"slackInstallations">;
    leadId?: Id<"leads">;
    opportunityId?: Id<"opportunities">;
    resultKind:
      | "created_opportunity"
      | "duplicate_pending"
      | "already_booked"
      | "unlinked";
    fullName: string;
    platform: SocialPlatform;
    handle: string;
    qualifiedBy: {
      slackUserId: string;
      slackTeamId: string;
      submittedAt: number;
    };
    now: number;
  },
) {
  const eventId = await ctx.db.insert("slackQualificationEvents", {
    tenantId: args.tenantId,
    installationId: args.installationId,
    leadId: args.leadId,
    opportunityId: args.opportunityId,
    resultKind: args.resultKind,
    qualifiedBy: args.qualifiedBy,
    slackUserId: args.qualifiedBy.slackUserId,
    slackTeamId: args.qualifiedBy.slackTeamId,
    fullNameSnapshot: args.fullName.trim(),
    platform: args.platform,
    handleSnapshot: args.handle.trim(),
    submittedAt: args.qualifiedBy.submittedAt,
    createdAt: args.now,
  });
  await rebuildQualificationRow(ctx, eventId);
  return eventId;
}

export const create = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    installationId: v.id("slackInstallations"),
    fullName: v.string(),
    platform: socialPlatformValidator,
    handle: v.string(),
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
      socialHandle: { platform: args.platform, rawValue: args.handle },
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
      await insertQualificationEvent(ctx, {
        tenantId: args.tenantId,
        installationId: args.installationId,
        leadId: resolution.leadId,
        opportunityId: recent._id,
        resultKind: "duplicate_pending",
        fullName: args.fullName,
        platform: args.platform,
        handle: args.handle,
        qualifiedBy: args.qualifiedBy,
        now,
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
      await insertQualificationEvent(ctx, {
        tenantId: args.tenantId,
        installationId: args.installationId,
        leadId: resolution.leadId,
        opportunityId: alreadyBooked._id,
        resultKind:
          alreadyBooked.status === "qualified_pending"
            ? "duplicate_pending"
            : "already_booked",
        fullName: args.fullName,
        platform: args.platform,
        handle: args.handle,
        qualifiedBy: args.qualifiedBy,
        now,
      });
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
      qualifiedAt: args.qualifiedBy.submittedAt,
      createdAt: now,
      updatedAt: now,
      latestActivityAt: now,
    });

    await insertQualificationEvent(ctx, {
      tenantId: args.tenantId,
      installationId: args.installationId,
      leadId: resolution.leadId,
      opportunityId,
      resultKind: "created_opportunity",
      fullName: args.fullName,
      platform: args.platform,
      handle: args.handle,
      qualifiedBy: args.qualifiedBy,
      now,
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
    };
  },
});
