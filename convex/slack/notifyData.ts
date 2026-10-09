import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { log } from "../lib/observability/log";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "../lib/socialPlatform";
import {
  addBusinessDays,
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";
import { countGoalEligibleQualificationEvents } from "../reporting/lib/slackQualificationLedger";

const MAX_LEAD_GEN_ATTEMPTS_COUNTED = 200;

export const getQualifiedLeadForNotify = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    qualificationEventId: v.optional(v.id("slackQualificationEvents")),
  },
  handler: async (ctx, args) => {
    const [opportunity, lead, event] = await Promise.all([
      ctx.db.get("opportunities", args.opportunityId),
      ctx.db.get("leads", args.leadId),
      args.qualificationEventId
        ? ctx.db.get("slackQualificationEvents", args.qualificationEventId)
        : null,
    ]);

    if (
      !opportunity ||
      !lead ||
      opportunity.tenantId !== args.tenantId ||
      lead.tenantId !== args.tenantId ||
      !opportunity.qualifiedBy
    ) {
      return null;
    }

    // The event holds what the setter typed. The lead may be an existing one
    // whose name, newest handle, or country differ from the submission.
    if (
      event &&
      event.tenantId === args.tenantId &&
      event.opportunityId === args.opportunityId
    ) {
      return {
        leadFullName:
          event.fullNameSnapshot || lead.fullName || lead.email || "Lead",
        platform: event.platform,
        handle: event.handleSnapshot,
        country: event.countrySnapshot ?? lead.country,
        leadType: event.leadTypeSnapshot ?? lead.leadType,
        qualifiedBySlackUserId: event.slackUserId,
        submittedAt: event.submittedAt,
      };
    }

    // Jobs scheduled before qualification events carried form snapshots.
    const identifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", args.leadId))
      .take(20);
    const primary = identifiers
      .filter((identifier) =>
        SOCIAL_PLATFORMS.includes(identifier.type as SocialPlatform),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!primary) return null;

    return {
      leadFullName: lead.fullName ?? lead.email ?? "Lead",
      platform: primary.type as SocialPlatform,
      handle: primary.rawValue,
      country: lead.country,
      leadType: lead.leadType,
      qualifiedBySlackUserId: opportunity.qualifiedBy.slackUserId,
      submittedAt: opportunity.qualifiedBy.submittedAt,
    };
  },
});

export const getExistingOpportunityBumpForNotify = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    qualificationEventId: v.id("slackQualificationEvents"),
  },
  handler: async (ctx, args) => {
    const [opportunity, lead, event] = await Promise.all([
      ctx.db.get("opportunities", args.opportunityId),
      ctx.db.get("leads", args.leadId),
      ctx.db.get("slackQualificationEvents", args.qualificationEventId),
    ]);

    if (!opportunity || !lead || !event) {
      return null;
    }

    if (
      opportunity.tenantId !== args.tenantId ||
      lead.tenantId !== args.tenantId ||
      event.tenantId !== args.tenantId ||
      opportunity.leadId !== args.leadId ||
      event.leadId !== args.leadId ||
      event.opportunityId !== args.opportunityId ||
      event.resultKind !== "already_booked"
    ) {
      return null;
    }

    return {
      leadFullName:
        event.fullNameSnapshot || lead.fullName || lead.email || "Lead",
      platform: event.platform,
      handle: event.handleSnapshot,
      country: event.countrySnapshot ?? lead.country,
      leadType: event.leadTypeSnapshot ?? lead.leadType,
      opportunityStatus: opportunity.status,
      bumpedBySlackUserId: event.slackUserId,
      submittedAt: event.submittedAt,
    };
  },
});

export const getQualificationGoalProgress = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get("tenants", args.tenantId);
    const dailyTeamQualificationGoal =
      tenant?.slackQualificationDailyTeamQuota;

    if (
      dailyTeamQualificationGoal === undefined ||
      dailyTeamQualificationGoal <= 0
    ) {
      return null;
    }

    const businessDate = timestampToBusinessDateKey(args.now);
    const start = businessDateToUtcStart(businessDate);
    const end = businessDateToUtcStart(addBusinessDays(businessDate, 1));
    const { count: qualifiedCount, truncated } =
      await countGoalEligibleQualificationEvents(ctx, {
        tenantId: args.tenantId,
        start,
        end,
      });

    if (truncated) {
      log.warn("slack.notify.goal_count_truncated", {
        tenantId: args.tenantId,
        businessDate,
        qualifiedCount,
      });
    }

    return {
      qualifiedCount,
      dailyTeamQualificationGoal,
    };
  },
});

export const recordNotifyFailure = internalMutation({
  args: {
    installationId: v.id("slackInstallations"),
    slackErr: v.string(),
    clearChannel: v.boolean(),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db.get("slackInstallations", args.installationId);
    if (!installation) return;

    await ctx.db.patch("slackInstallations", args.installationId, {
      notifyChannelId: args.clearChannel
        ? undefined
        : installation.notifyChannelId,
      notifyChannelName: args.clearChannel
        ? undefined
        : installation.notifyChannelName,
      notifyChannelError: {
        code: args.slackErr,
        channelId: installation.notifyChannelId ?? "unknown",
        channelName: installation.notifyChannelName,
        occurredAt: Date.now(),
      },
    });
  },
});

export const getLeadGenSubmissionForNotify = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    submissionId: v.id("leadGenSubmissions"),
  },
  handler: async (ctx, args) => {
    const submission = await ctx.db.get("leadGenSubmissions", args.submissionId);
    if (!submission || submission.tenantId !== args.tenantId) return null;
    if (submission.voidedAt !== undefined) return { kind: "voided" as const };

    const [prospect, worker, team] = await Promise.all([
      ctx.db.get("leadGenProspects", submission.prospectId),
      ctx.db.get("leadGenWorkers", submission.workerId),
      submission.teamId ? ctx.db.get("attributionTeams", submission.teamId) : null,
    ]);
    if (!prospect || !worker) return null;

    // Count this prospect's live submissions up to this one, so a late or
    // retried post still shows the attempt number it had when submitted.
    // Read newest first from this submission so the cap drops the oldest rows.
    const recentSubmissions = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_prospectId_and_submittedAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("prospectId", submission.prospectId)
          .lte("submittedAt", submission.submittedAt),
      )
      .order("desc")
      .take(MAX_LEAD_GEN_ATTEMPTS_COUNTED + 1);
    const contactAttemptCapped =
      recentSubmissions.length > MAX_LEAD_GEN_ATTEMPTS_COUNTED;
    const contactAttemptNumber = recentSubmissions
      .slice(0, MAX_LEAD_GEN_ATTEMPTS_COUNTED)
      .filter(
        (row) =>
          row.voidedAt === undefined &&
          // Same-millisecond submissions inserted after this one came later.
          !(
            row.submittedAt === submission.submittedAt &&
            row._creationTime > submission._creationTime
          ),
      ).length;

    return {
      kind: "ready" as const,
      handle: prospect.normalizedHandle,
      profileUrl: prospect.profileUrl,
      source: submission.source,
      originKind: submission.originKind,
      originValue: submission.originValue,
      submittedByName: worker.displayName?.trim() || worker.email,
      teamName: team?.displayName,
      contactAttemptNumber: Math.max(contactAttemptNumber, 1),
      contactAttemptCapped,
      submittedAt: submission.submittedAt,
    };
  },
});

export const recordLeadGenNotifyFailure = internalMutation({
  args: {
    installationId: v.id("slackInstallations"),
    channelId: v.string(),
    slackErr: v.string(),
    clearChannel: v.boolean(),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db.get("slackInstallations", args.installationId);
    // An admin may have changed or turned off the channel since the post.
    if (!installation || installation.leadGenNotifyChannelId !== args.channelId) {
      return;
    }

    await ctx.db.patch("slackInstallations", args.installationId, {
      leadGenNotifyChannelId: args.clearChannel
        ? undefined
        : installation.leadGenNotifyChannelId,
      leadGenNotifyChannelName: args.clearChannel
        ? undefined
        : installation.leadGenNotifyChannelName,
      leadGenNotifyChannelError: {
        code: args.slackErr,
        channelId: args.channelId,
        channelName: installation.leadGenNotifyChannelName,
        occurredAt: Date.now(),
      },
    });
  },
});
