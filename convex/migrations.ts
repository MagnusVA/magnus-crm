import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { adoptRawDelivery, deliveryMetadata } from "./pipeline/receipts";
import {
  DISMISSED_REASON,
  dismissBlockedDelivery,
  isDismissible,
} from "./pipeline/dismissal";
import { requestMeetingProjection, bucketKey, meetingDayKey } from "./operations/meetingStats";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { computeLatestActivityAt } from "./lib/opportunityActivity";
import { leadGenWeekdayForBusinessDate } from "./leadGen/schedules";
import { rebuildLeadCustomerSearchRow } from "./leadCustomers/projection";
import { upsertOpportunitySearchProjection } from "./lib/opportunitySearch";
import {
  insertOperationsMeetingStats,
  replaceOperationsMeetingStats,
} from "./operations/meetingStats";
import { rebuildQualificationRow } from "./operations/projections";
import { extractPerson, finalizePlan, movePerson } from "./leadSplit/apply";
import { assertPersonApplied } from "./leadSplit/verify";
import {
  expireStaleSlackOpportunity,
  isStaleSlackBacklog,
} from "./slack/staleExpiry";

export const migrations = new Migrations<DataModel>(components.migrations);

export const run = migrations.runner();

export const backfillOpportunitySourceAndActivity = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (ctx, opportunity) => {
    const patch: {
      source?: "calendly";
      latestActivityAt?: number;
    } = {};

    if (opportunity.source === undefined) {
      patch.source = "calendly";
    }

    if (opportunity.latestActivityAt === undefined) {
      patch.latestActivityAt = computeLatestActivityAt(opportunity);
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch("opportunities", opportunity._id, patch);
    }
  },
});

export const assertOpportunitySourceAndActivityBackfilled = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (_ctx, opportunity) => {
    if (opportunity.source === undefined) {
      throw new Error(`Opportunity ${opportunity._id} is missing source`);
    }
    if (opportunity.latestActivityAt === undefined) {
      throw new Error(
        `Opportunity ${opportunity._id} is missing latestActivityAt`,
      );
    }
  },
});

export const backfillOpportunitySearchProjection = migrations.define({
  table: "opportunities",
  batchSize: 100,
  migrateOne: async (ctx, opportunity) => {
    await upsertOpportunitySearchProjection(ctx, opportunity._id);
  },
});

export const assertOpportunitySearchProjectionBackfilled = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (ctx, opportunity) => {
    const projection = await ctx.db
      .query("opportunitySearch")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", opportunity._id),
      )
      .unique();

    if (!projection) {
      throw new Error(
        `Opportunity ${opportunity._id} is missing an opportunitySearch projection`,
      );
    }
    if (
      projection.tenantId !== opportunity.tenantId ||
      projection.leadId !== opportunity.leadId ||
      projection.status !== opportunity.status
    ) {
      throw new Error(
        `Opportunity ${opportunity._id} has a stale opportunitySearch projection`,
      );
    }
  },
});

export const backfillLeadCustomerSearchRows = migrations.define({
  table: "leads",
  batchSize: 100,
  migrateOne: async (ctx, lead) => {
    await rebuildLeadCustomerSearchRow(ctx, lead.tenantId, lead._id);
  },
});

export const assertLeadCustomerSearchRowsBackfilled = migrations.define({
  table: "leads",
  batchSize: 100,
  migrateOne: async (ctx, lead) => {
    const row = await ctx.db
      .query("leadCustomerSearchRows")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", lead.tenantId).eq("leadId", lead._id),
      )
      .unique();

    if (!row) {
      throw new Error(`Lead ${lead._id} is missing leadCustomerSearchRows row`);
    }
    if (row.tenantId !== lead.tenantId || row.leadId !== lead._id) {
      throw new Error(`Lead ${lead._id} has mismatched projection identity`);
    }
    if (row.leadStatus !== lead.status) {
      throw new Error(`Lead ${lead._id} has stale leadStatus projection`);
    }

    const customer = await ctx.db
      .query("customers")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", lead.tenantId).eq("leadId", lead._id),
      )
      .first();
    const expectedLifecycle =
      lead.status === "merged" ? "merged" : customer ? "customer" : "lead";

    if (row.lifecycle !== expectedLifecycle) {
      throw new Error(`Lead ${lead._id} has stale lifecycle projection`);
    }
    if (row.isSearchVisible !== (expectedLifecycle !== "merged")) {
      throw new Error(`Lead ${lead._id} has invalid visibility projection`);
    }
    if (row.customerId !== customer?._id) {
      throw new Error(`Lead ${lead._id} has stale customer projection`);
    }
  },
});

export const backfillSlackQualificationEvents = migrations.define({
  table: "opportunities",
  batchSize: 100,
  migrateOne: async (ctx, opportunity) => {
    if (opportunity.source !== "slack_qualified" || !opportunity.qualifiedBy) {
      return;
    }

    const existing = await ctx.db
      .query("slackQualificationEvents")
      .withIndex("by_tenantId_and_opportunityId", (q) =>
        q
          .eq("tenantId", opportunity.tenantId)
          .eq("opportunityId", opportunity._id),
      )
      .first();
    if (existing) {
      await rebuildQualificationRow(ctx, existing._id);
      return;
    }

    const lead = await ctx.db.get("leads", opportunity.leadId);
    const installations = await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId_and_appId", (q) =>
        q.eq("teamId", opportunity.qualifiedBy!.slackTeamId),
      )
      .take(10);
    const installation = installations.find(
      (row) => row.tenantId === opportunity.tenantId && row.status === "active",
    );
    if (!installation) {
      throw new Error(
        `Missing active Slack installation for opportunity ${opportunity._id}`,
      );
    }

    const eventId = await ctx.db.insert("slackQualificationEvents", {
      tenantId: opportunity.tenantId,
      installationId: installation._id,
      leadId: opportunity.leadId,
      opportunityId: opportunity._id,
      resultKind: "created_opportunity",
      qualifiedBy: opportunity.qualifiedBy,
      slackUserId: opportunity.qualifiedBy.slackUserId,
      slackTeamId: opportunity.qualifiedBy.slackTeamId,
      fullNameSnapshot: lead?.fullName ?? lead?.email ?? "Unknown lead",
      platform: "other_social",
      handleSnapshot: "",
      submittedAt: opportunity.qualifiedBy.submittedAt,
      createdAt: opportunity.createdAt,
    });

    if (opportunity.qualifiedAt === undefined) {
      await ctx.db.patch("opportunities", opportunity._id, {
        qualifiedAt: opportunity.qualifiedBy.submittedAt,
      });
    }
    await rebuildQualificationRow(ctx, eventId);
  },
});

// Fix forward: before transitionOpportunity, closer, admin and side-deal
// outcomes never rebuilt qualification rows, so a row could keep the status
// and closer from booking time.
export const rebuildQualificationRows = migrations.define({
  table: "slackQualificationEvents",
  batchSize: 100,
  migrateOne: async (ctx, event) => {
    await rebuildQualificationRow(ctx, event._id);
  },
});

export const assertQualificationRowsCurrent = migrations.define({
  table: "slackQualificationEvents",
  batchSize: 200,
  migrateOne: async (ctx, event) => {
    const row = await ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_qualificationEventId", (q) =>
        q.eq("qualificationEventId", event._id),
      )
      .unique();
    if (!row) {
      throw new Error(`Qualification event ${event._id} has no qualification row`);
    }
    const opportunity = event.opportunityId
      ? await ctx.db.get("opportunities", event.opportunityId)
      : null;
    if (
      row.opportunityStatus !== opportunity?.status ||
      row.assignedCloserId !== opportunity?.assignedCloserId
    ) {
      throw new Error(`Qualification event ${event._id} has a stale qualification row`);
    }
  },
});

// Closes the Slack opportunities that had already passed the stale expiry
// before the hourly cron's cutover (slack/staleExpiry.ts). Check the count
// with slack/staleExpiry:previewStaleSlackOpportunities first. Each closed
// opportunity is a real lost deal, with its counters and domain event.
export const expireStaleSlackBacklog = migrations.define({
  table: "opportunities",
  batchSize: 20,
  migrateOne: async (ctx, opportunity) => {
    if (isStaleSlackBacklog(opportunity)) {
      await expireStaleSlackOpportunity(ctx, opportunity._id, Date.now());
    }
  },
});

export const assertStaleSlackBacklogExpired = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (_ctx, opportunity) => {
    if (isStaleSlackBacklog(opportunity)) {
      throw new Error(`Slack opportunity ${opportunity._id} is still pending past the expiry`);
    }
  },
});

export const backfillMeetingOpportunityStatusAndOperationsStats =
  migrations.define({
    table: "meetings",
    batchSize: 100,
    migrateOne: async (ctx, meeting) => {
      const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
      const opportunityStatus = opportunity?.status;
      const nextMeeting = { ...meeting, opportunityStatus };

      if (meeting.opportunityStatus !== opportunityStatus) {
        await ctx.db.patch("meetings", meeting._id, { opportunityStatus });
      }

      if (meeting.operationsStatsSyncedAt !== undefined) {
        if (meeting.opportunityStatus !== opportunityStatus) {
          await replaceOperationsMeetingStats(ctx, meeting, nextMeeting);
        }
        return;
      }

      await insertOperationsMeetingStats(ctx, nextMeeting);
    },
  });

export const backfillLeadGenDailyStatScheduledHours = migrations.define({
  table: "leadGenDailyStats",
  batchSize: 100,
  migrateOne: async (ctx, stat) => {
    const weekday = leadGenWeekdayForBusinessDate(stat.dayKey);
    const schedule = await ctx.db
      .query("leadGenWorkerSchedules")
      .withIndex("by_tenantId_and_workerId_and_weekday", (q) =>
        q
          .eq("tenantId", stat.tenantId)
          .eq("workerId", stat.workerId)
          .eq("weekday", weekday),
      )
      .unique();
    const scheduledHours = schedule?.scheduledHours ?? 0;

    if (stat.scheduledHours !== scheduledHours) {
      await ctx.db.patch("leadGenDailyStats", stat._id, {
        scheduledHours,
        updatedAt: Date.now(),
      });
    }
  },
});

// Workpool rollout: widen schema, adopt receipts, rebuild from source, drain,
// assert every source and bucket, then enable readers. Never seed from old totals.
export const adoptWebhookDeliveryReceipts = migrations.define({
  table: "rawWebhookEvents", batchSize: 32,
  migrateOne: async (ctx, raw) => { await adoptRawDelivery(ctx, raw); },
});
export const assertWebhookDeliveryReceipts = migrations.define({
  table: "rawWebhookEvents", batchSize: 64,
  migrateOne: async (ctx, raw) => {
    const metadata = await deliveryMetadata(raw);
    const receipt = await ctx.db.query("webhookDeliveries").withIndex("by_tenantId_and_key", q => q.eq("tenantId", raw.tenantId).eq("key", metadata.key)).unique();
    if (!receipt) throw new Error("Webhook receipt missing");
  },
});
// Fix forward after PR #91: dismiss deliveries the old pipeline blocked. Preview
// with pipeline/dismissal:previewBlockedBacklogDismissal, undo with
// pipeline/dismissal:restoreDismissedDeliveries.
export const dismissBlockedBacklog = migrations.define({
  table: "webhookDeliveries", batchSize: 100,
  migrateOne: async (ctx, row) => { await dismissBlockedDelivery(ctx, row); },
});
export const assertBlockedBacklogDismissed = migrations.define({
  table: "webhookDeliveries", batchSize: 100,
  migrateOne: async (ctx, row) => {
    const log = await ctx.db.query("webhookDeliveryDismissals").withIndex("by_deliveryId", q => q.eq("deliveryId", row._id)).order("desc").first();
    // Deliveries restored on purpose are back in review and expected to be blocked.
    if (isDismissible(row) && log?.restoredAt === undefined) throw new Error(`Delivery ${row._id} is still blocked`);
    if (row.status !== "ignored" || row.reason !== DISMISSED_REASON) return;
    if (!log || log.restoredAt !== undefined) throw new Error(`Delivery ${row._id} has no dismissal log`);
    const raw = await ctx.db.get("rawWebhookEvents", row.rawEventId);
    if (raw && (!raw.processed || raw.processingReason !== DISMISSED_REASON)) throw new Error(`Delivery ${row._id} raw event is not resolved`);
  },
});
export const rebuildMeetingProjections = migrations.define({
  table: "meetings", batchSize: 32,
  migrateOne: async (ctx, meeting) => { await requestMeetingProjection(ctx, meeting.tenantId, meeting._id); },
});
export const assertMeetingProjections = migrations.define({
  table: "meetings", batchSize: 64,
  migrateOne: async (ctx, meeting) => {
    const projection = await ctx.db.query("meetingProjections").withIndex("by_meetingId", q => q.eq("meetingId", meeting._id)).unique();
    const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== meeting.tenantId) throw new Error("Invalid meeting relationship");
    const key = bucketKey({ dayKey: meetingDayKey(meeting.scheduledAt), assignedCloserId: meeting.assignedCloserId,
      bookingProgramId: meeting.bookingProgramId, soldProgramId: opportunity.soldProgramId,
      attributionTeamId: meeting.attributionTeamId, dmCloserId: meeting.dmCloserId, opportunityStatus: opportunity.status, meetingStatus: meeting.status });
    const bucket = await ctx.db.query("operationsMeetingStatsV2").withIndex("by_tenantId_and_bucketKey", q => q.eq("tenantId", meeting.tenantId).eq("bucketKey", key)).unique();
    if (!bucket || projection?.tenantId !== meeting.tenantId || projection.status !== "applied" || projection.bucketKey !== key) throw new Error("Meeting projection is missing or stale; drain and rerun assertion");
  },
});
export const assertMeetingProjectionBuckets = migrations.define({
  table: "operationsMeetingStatsV2", batchSize: 1,
  migrateOne: async (ctx, bucket) => {
    // Large buckets use pagination across separate migration rows in a future
    // warehouse cutover; fail explicitly instead of accepting a partial count.
    const contributions = await ctx.db.query("meetingProjections").withIndex("by_tenantId_and_bucketKey", q => q.eq("tenantId", bucket.tenantId).eq("bucketKey", bucket.bucketKey)).take(8193);
    if (contributions.length > 8192) throw new Error("Bucket verification exceeds live limit");
    if (bucket.count <= 0 || bucket.count !== contributions.length) throw new Error("Projection bucket count mismatch");
  },
});
export const assertMeetingProjectionSources = migrations.define({
  table: "meetingProjections", batchSize: 64,
  migrateOne: async (ctx, projection) => {
    const meeting = await ctx.db.get("meetings", projection.meetingId);
    if (projection.status !== "applied") throw new Error("Projection work is unfinished");
    if (meeting && meeting.tenantId !== projection.tenantId) throw new Error("Projection tenant mismatch");
    if (!meeting && (projection.contribution || projection.bucketKey)) throw new Error("Deleted meeting still contributes to reports");
    if (projection.contribution && projection.bucketKey !== bucketKey(projection.contribution)) throw new Error("Projection contribution key mismatch");
  },
});
export const activateMeetingProjections = internalMutation({
  args: { tenantId: v.id("tenants") }, returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    const statuses = await migrations.getStatus(ctx, { migrations: [
      internal.migrations.rebuildMeetingProjections, internal.migrations.assertMeetingProjections,
      internal.migrations.assertMeetingProjectionBuckets, internal.migrations.assertMeetingProjectionSources,
    ] });
    if (statuses.length !== 4 || statuses.some(s => !s.isDone)) throw new Error("Complete rebuild and all three assertions before activating reports");
    for (const status of ["queued", "failed"] as const) {
      const pending = await ctx.db.query("meetingProjections").withIndex("by_tenantId_and_status_and_requestedAt", q => q.eq("tenantId", tenantId).eq("status", status)).first();
      const fanout = await ctx.db.query("opportunityProjectionJobs").withIndex("by_tenantId_and_status_and_requestedAt", q => q.eq("tenantId", tenantId).eq("status", status)).first();
      if (pending || fanout) throw new Error("Drain reporting work before activating reports");
    }
    await ctx.db.patch("tenants", tenantId, { meetingProjectionVersion: 2 });
    return null;
  },
});

// Polluted-lead split, phase 5 (docs/plans/polluted-lead-split.md §5.6). Each
// acts only on approved plans, one person or plan per transaction. Run in
// this order, then the assert; `next` chains them:
// npx convex run migrations:run '{"fn":"migrations:applyLeadSplitExtractions","next":["migrations:applyLeadSplitPersons","migrations:finalizeLeadSplitPlans"]}'
// A run after a later approval needs `"reset": true`. Undo a plan with
// leadSplit/rollback:rollbackPlan.
export const applyLeadSplitExtractions = migrations.define({
  table: "leadSplitPersons", batchSize: 1,
  migrateOne: async (ctx, person) => { await extractPerson(ctx, person._id); },
});
export const applyLeadSplitPersons = migrations.define({
  table: "leadSplitPersons", batchSize: 1,
  migrateOne: async (ctx, person) => { await movePerson(ctx, person._id); },
});
export const finalizeLeadSplitPlans = migrations.define({
  table: "leadSplitPlans", batchSize: 1,
  migrateOne: async (ctx, plan) => { await finalizePlan(ctx, plan._id); },
});
// Tenant-wide checks run with leadSplit/verify:verifyTenant.
export const assertLeadSplitPersonsApplied = migrations.define({
  table: "leadSplitPersons", batchSize: 10,
  migrateOne: async (ctx, person) => { await assertPersonApplied(ctx, person); },
});
