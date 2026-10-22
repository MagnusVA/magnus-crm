import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { resolveLeadIdentity } from "../leads/identityResolution";
import {
  qualificationCreditsSetter,
  recordDealCreation,
  recordSetterAttribution,
} from "../lib/attribution/dealAttributions";
import { emitDomainEvent } from "../lib/domainEvents";
import { recordSlackQualification } from "../lib/leadLifecycle";
import { type LeadType, leadTypeValidator } from "../lib/leadType";
import { describeError, log, reportError } from "../lib/observability/log";
import type { SocialPlatform } from "../lib/socialPlatform";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { rebuildQualificationRow } from "../operations/projections";
import { blocksNewQualification, isQualifiedDeal } from "../opportunities/dealGuards";
import { newDealStageFields } from "../opportunities/dealState";
import { dealStageOf } from "../opportunities/stages";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { SLACK_JOIN_LOOKBACK_MS } from "../pipeline/slackJoinLookup";
import { upsertSlackUserOnSubmission } from "./users";


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
    country: string;
    leadType: LeadType;
    qualifiedBy: {
      slackUserId: string;
      slackTeamId: string;
      submittedAt: number;
    };
    /** The setter who qualified the person. */
    setterTeamMemberId: Id<"teamMembers"> | undefined;
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
    countrySnapshot: args.country.trim(),
    leadTypeSnapshot: args.leadType,
    submittedAt: args.qualifiedBy.submittedAt,
    createdAt: args.now,
  });
  // A qualification that created the deal or joined it while it waits for a
  // booking credits its setter (docs/plans/phase-3-attribution.md §4.4).
  if (args.opportunityId && qualificationCreditsSetter(args.resultKind)) {
    await recordSetterAttribution(ctx, {
      tenantId: args.tenantId,
      opportunityId: args.opportunityId,
      slackUserId: args.qualifiedBy.slackUserId,
      submittedAt: args.qualifiedBy.submittedAt,
      qualificationEventId: eventId,
    });
  }
  await rebuildQualificationRow(ctx, eventId);
  await recordSlackQualification(ctx, eventId);
  if (args.leadId) {
    await emitSlackQualifiedTouch(ctx, {
      tenantId: args.tenantId,
      leadId: args.leadId,
      qualificationEventId: eventId,
      opportunityId: args.opportunityId,
      resultKind: args.resultKind,
      setterTeamMemberId: args.setterTeamMemberId,
      at: args.qualifiedBy.submittedAt,
    });
  }
  return eventId;
}

export const SLACK_QUALIFIED = "lead.slack_qualified";

/**
 * Every qualification is a touch on the person's timeline, by the setter,
 * including the ones that join an open deal
 * (docs/plans/phase-2-person-first.md §5).
 */
export async function emitSlackQualifiedTouch(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    qualificationEventId: Id<"slackQualificationEvents">;
    opportunityId?: Id<"opportunities">;
    resultKind: string;
    setterTeamMemberId: Id<"teamMembers"> | undefined;
    at: number;
    skipAnalytics?: boolean;
  },
): Promise<void> {
  await emitDomainEvent(ctx, {
    tenantId: args.tenantId,
    entityType: "lead",
    entityId: args.leadId,
    eventType: SLACK_QUALIFIED,
    source: "pipeline",
    teamMemberId: args.setterTeamMemberId,
    metadata: {
      qualificationEventId: args.qualificationEventId,
      opportunityId: args.opportunityId,
      resultKind: args.resultKind,
    },
    occurredAt: args.at,
    skipAnalytics: args.skipAnalytics,
  });
}

export const create = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    installationId: v.id("slackInstallations"),
    fullName: v.string(),
    handle: v.string(),
    country: v.string(),
    leadType: leadTypeValidator,
    qualifiedBy: v.object({
      slackUserId: v.string(),
      slackTeamId: v.string(),
      submittedAt: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const platform: SocialPlatform = "instagram";
    async function scheduleLeadGenAuditMatch(params: {
      resultKind:
        | "created_opportunity"
        | "duplicate_pending"
        | "already_booked";
      leadId: Id<"leads">;
      opportunityId?: Id<"opportunities">;
    }) {
      if (params.resultKind === "already_booked") {
        return;
      }

      try {
        await ctx.scheduler.runAfter(
          0,
          internal.leadGen.auditMatching.matchQualifiedLead,
          {
            tenantId: args.tenantId,
            leadId: params.leadId,
            opportunityId: params.opportunityId,
            platform: "instagram",
            rawHandle: args.handle,
            matchSource: "slack_qualification",
          },
        );
      } catch (error) {
        // Swallowed so the qualification still commits without an audit match.
        // The scheduler error can echo the args (the raw handle), so report a
        // constant message.
        reportError(
          "lead_gen.audit_match.schedule_failed",
          new Error("Scheduling the lead-gen audit match failed"),
          {
            fingerprint: "lead_gen.audit_match.schedule_failed",
            errorName: describeError(error).name,
            tenantId: args.tenantId,
            leadId: params.leadId,
            opportunityId: params.opportunityId,
            matchSource: "slack_qualification",
          },
        );
      }
    }

    const resolution = await resolveLeadIdentity(ctx, {
      tenantId: args.tenantId,
      socialHandle: { platform, rawValue: args.handle },
      fullName: args.fullName,
      identifierSource: "slack_qualified",
      createIfMissing: true,
      createIdentifiers: true,
      createdAt: now,
      initialLifecycle: { stage: "qualified", at: args.qualifiedBy.submittedAt },
    });

    await ctx.db.patch("leads", resolution.leadId, {
      country: args.country.trim(),
      leadType: args.leadType,
      updatedAt: now,
    });

    const slackUserRowId = await upsertSlackUserOnSubmission(ctx, {
      tenantId: args.tenantId,
      installationId: args.installationId,
      slackUserId: args.qualifiedBy.slackUserId,
      slackTeamId: args.qualifiedBy.slackTeamId,
      now,
    });
    const setterTeamMemberId = (await ctx.db.get("slackUsers", slackUserRowId))?.teamMemberId;

    // A Qualified Slack deal from the join window is a pending duplicate.
    const lookbackCutoff = now - SLACK_JOIN_LOOKBACK_MS;
    const recent = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_leadId_source_stage_outcome_createdAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("leadId", resolution.leadId)
          .eq("source", "slack_qualified")
          .eq("stage", "qualified")
          .eq("outcome", "open")
          .gt("createdAt", lookbackCutoff),
      )
      .order("desc")
      .first();

    if (recent) {
      log.info("slack.qualified_lead.duplicate_skipped", {
        tenantId: args.tenantId,
        outcome: "duplicate_pending",
        reason: "recent_pending_opportunity",
        leadId: resolution.leadId,
        opportunityId: recent._id,
      });
      await insertQualificationEvent(ctx, {
        tenantId: args.tenantId,
        installationId: args.installationId,
        leadId: resolution.leadId,
        opportunityId: recent._id,
        resultKind: "duplicate_pending",
        fullName: args.fullName,
        platform,
        handle: args.handle,
        country: args.country,
        leadType: args.leadType,
        qualifiedBy: args.qualifiedBy,
        setterTeamMemberId,
        now,
      });
      await scheduleLeadGenAuditMatch({
        resultKind: "duplicate_pending",
        leadId: resolution.leadId,
        opportunityId: recent._id,
      });
      return {
        kind: "duplicate_pending" as const,
        existingOpportunityId: recent._id,
        priorQualifiedBy: recent.qualifiedBy ?? null,
      };
    }

    const existingOppsForLead = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", args.tenantId).eq("leadId", resolution.leadId),
      )
      .order("desc")
      .take(20);
    // Only a deal still in progress blocks a new qualification. A won deal
    // doesn't: a second program is a new deal (ADR 0001, decision 3), and
    // neither does a deal a missed meeting closed (D16). Nor does a
    // Qualified deal past the join window: no booking can join it, and the
    // stale expiry closes it.
    const alreadyBooked = existingOppsForLead.find((opportunity) =>
      blocksNewQualification(opportunity, lookbackCutoff),
    );
    if (alreadyBooked) {
      const resultKind = isQualifiedDeal(alreadyBooked)
        ? "duplicate_pending"
        : "already_booked";
      const qualificationEventId = await insertQualificationEvent(ctx, {
        tenantId: args.tenantId,
        installationId: args.installationId,
        leadId: resolution.leadId,
        opportunityId: alreadyBooked._id,
        resultKind,
        fullName: args.fullName,
        platform,
        handle: args.handle,
        country: args.country,
        leadType: args.leadType,
        qualifiedBy: args.qualifiedBy,
        setterTeamMemberId,
        now,
      });
      await scheduleLeadGenAuditMatch({
        resultKind,
        leadId: resolution.leadId,
        opportunityId: alreadyBooked._id,
      });

      if (resultKind === "already_booked") {
        await ctx.scheduler.runAfter(
          0,
          internal.slack.notify.postExistingOpportunityBump,
          {
            tenantId: args.tenantId,
            opportunityId: alreadyBooked._id,
            leadId: resolution.leadId,
            qualificationEventId,
          },
        );
        log.info("slack.qualified_lead.opportunity_bumped", {
          tenantId: args.tenantId,
          outcome: "existing_opportunity_bump",
          leadId: resolution.leadId,
          opportunityId: alreadyBooked._id,
          dealStage: dealStageOf(alreadyBooked).stage,
          qualificationEventId,
        });
        return {
          kind: "existing_opportunity_bump" as const,
          existingOpportunityId: alreadyBooked._id,
          leadId: resolution.leadId,
          qualificationEventId,
        };
      }

      log.info("slack.qualified_lead.duplicate_skipped", {
        tenantId: args.tenantId,
        outcome: "duplicate_pending",
        reason: "pending_opportunity_for_lead",
        leadId: resolution.leadId,
        opportunityId: alreadyBooked._id,
        qualificationEventId,
      });
      return {
        kind: "duplicate_pending" as const,
        existingOpportunityId: alreadyBooked._id,
        priorQualifiedBy: alreadyBooked.qualifiedBy ?? null,
      };
    }

    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId: args.tenantId,
      leadId: resolution.leadId,
      source: "slack_qualified",
      ...newDealStageFields("qualified"),
      qualifiedBy: args.qualifiedBy,
      qualifiedAt: args.qualifiedBy.submittedAt,
      createdAt: now,
      updatedAt: now,
      latestActivityAt: now,
    });

    const qualificationEventId = await insertQualificationEvent(ctx, {
      tenantId: args.tenantId,
      installationId: args.installationId,
      leadId: resolution.leadId,
      opportunityId,
      resultKind: "created_opportunity",
      fullName: args.fullName,
      platform,
      handle: args.handle,
      country: args.country,
      leadType: args.leadType,
      qualifiedBy: args.qualifiedBy,
      setterTeamMemberId,
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
      // The stage it starts at (docs/plans/phase-5-deal-status.md §4.7).
      toStatus: "qualified",
      occurredAt: now,
      // The setter who qualified the person acted, not a CRM user.
      teamMemberId: setterTeamMemberId,
      metadata: { source: "slack_qualified", toOutcome: "open" },
    });
    await recordDealCreation(ctx, opportunityId);

    await ctx.scheduler.runAfter(0, internal.slack.notify.postConfirmation, {
      tenantId: args.tenantId,
      opportunityId,
      leadId: resolution.leadId,
      qualificationEventId,
    });
    await scheduleLeadGenAuditMatch({
      resultKind: "created_opportunity",
      leadId: resolution.leadId,
      opportunityId,
    });

    log.info("slack.qualified_lead.created", {
      tenantId: args.tenantId,
      outcome: "created",
      opportunityId,
      leadId: resolution.leadId,
      isNewLead: resolution.isNewLead,
      resolvedVia: resolution.resolvedVia,
    });

    return {
      kind: "created" as const,
      opportunityId,
      leadId: resolution.leadId,
      isNewLead: resolution.isNewLead,
    };
  },
});
