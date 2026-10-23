import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { adoptRawDelivery, deliveryMetadata } from "./pipeline/receipts";
import {
  DISMISSED_REASON,
  dismissBlockedDelivery,
  isDismissible,
} from "./pipeline/dismissal";
import { requestMeetingProjection, bucketKey, meetingDayKey } from "./operations/meetingStats";
import { components, internal } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import {
  attributionsForDeal,
  attributionsForMeeting,
  expectedLeadGenRow,
  qualificationCreditsSetter,
  type DealAttribution,
} from "./lib/attribution/dealAttributions";
import { deriveStoredEventLinks, storedLeadIdMatches } from "./lib/domainEventLinks";
import { getPersonProgramEnrollment } from "./enrollments/read";
import { derivePersonEnrollments, paymentCounts } from "./lib/enrollments";
import { lifecycleProblems } from "./lib/leadLifecycle";
import { patchMeetingLifecycle } from "./lib/meetingLifecycle";
import { computeLatestActivityAt } from "./lib/opportunityActivity";
import {
  ensureUserTeamMember,
  linkDmCloserTeamMember,
  linkLeadGenWorkerTeamMember,
  linkSlackUserTeamMember,
  teamMemberRoleRecords,
} from "./lib/teamMembers";
import { leadGenWeekdayForBusinessDate } from "./leadGen/schedules";
import {
  customerFieldsFromEnrollments,
  isVisibleLifecycle,
  loadPersonDeals,
  projectedLifecycle,
  rebuildLeadCustomerSearchRow,
} from "./leadCustomers/projection";
import { upsertOpportunitySearchProjection } from "./lib/opportunitySearch";
import { qualificationRowStage, rebuildQualificationRow } from "./operations/projections";
import {
  expireStaleSlackOpportunity,
  isStaleSlackBacklog,
} from "./slack/staleExpiry";
import {
  computePersonTouches,
  sameTouch,
  type TouchSnapshot,
} from "./lib/touches";
import { isAllowedStageOutcome } from "./opportunities/stages";
import {
  isMissedMeetingLoss,
  loadPendingRescheduleLink,
} from "./opportunities/dealState";
import { opportunityByStage } from "./reporting/aggregates";
import {
  isOpenDealAgingEligible,
  isPersonLossEligible,
  openDealAging,
  personLosses,
} from "./reporting/pipelineHealthAggregates";

export const migrations = new Migrations<DataModel>(components.migrations);

export const run = migrations.runner();

export const backfillOpenDealAging = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (ctx, deal) => {
    if (isOpenDealAgingEligible(deal)) {
      await openDealAging.insertIfDoesNotExist(ctx, deal);
    }
  },
});

// Phase 6 PR 4. These copies are absent from aggregate keys and projections
// (reporting/aggregates.ts, lib/opportunityActivity.ts), so clearing them needs
// no lifecycle write, activity timestamp change, event, or projection rebuild.
export const clearDealMeetingTimes = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (ctx, deal) => {
    if (deal.canceledAt !== undefined || deal.noShowAt !== undefined) {
      await ctx.db.patch("opportunities", deal._id, {
        canceledAt: undefined,
        noShowAt: undefined,
      });
    }
  },
});

export const backfillPersonLosses = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (ctx, deal) => {
    if (isPersonLossEligible(deal)) {
      await personLosses.insertIfDoesNotExist(ctx, deal);
    }
  },
});

export const assertDealMeetingTimesCleared = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (_ctx, deal) => {
    if (deal.canceledAt !== undefined || deal.noShowAt !== undefined) {
      throw new Error(`Deal meeting times remain: ${deal._id}`);
    }
  },
});

/** Prove membership at the expected key for THIS deal, not another deal
 * sharing its key. The component records progress only after a batch passes. */
export const assertPipelineHealthAggregates = migrations.define({
  table: "opportunities",
  // Up to four aggregate lookups (count and sum, two aggregates) per open
  // deal, each a few index reads: 100 deals stay well under 4,096 reads.
  batchSize: 100,
  migrateOne: async (ctx, deal) => {
    if (isOpenDealAgingEligible(deal)) {
      const key: [typeof deal.stage, number] = [deal.stage, deal.nextMeetingAt ?? 0];
      const bound = { key, id: deal._id, inclusive: true };
      if (await openDealAging.count(ctx, {
        namespace: deal.tenantId,
        bounds: { lower: bound, upper: bound },
      }) !== 1) {
        throw new Error(`openDealAging mismatch: ${deal._id}`);
      }
      if (await openDealAging.sum(ctx, {
        namespace: deal.tenantId,
        bounds: { lower: bound, upper: bound },
      }) !== deal.createdAt) {
        throw new Error(`openDealAging sum mismatch: ${deal._id}`);
      }
    }
    if (isPersonLossEligible(deal)) {
      const key: [number, Id<"users"> | ""] = [deal.lostAt!, deal.lostByUserId ?? ""];
      const bound = { key, id: deal._id, inclusive: true };
      if (await personLosses.count(ctx, {
        namespace: deal.tenantId,
        bounds: { lower: bound, upper: bound },
      }) !== 1) {
        throw new Error(`personLosses mismatch: ${deal._id}`);
      }
    }
  },
});

export const deleteLegacyMeetingDailyStats = migrations.define({
  table: "operationsMeetingDailyStats",
  batchSize: 200,
  migrateOne: async (ctx, row) => {
    await ctx.db.delete("operationsMeetingDailyStats", row._id);
  },
});

export const assertLegacyMeetingDailyStatsEmpty = migrations.define({
  table: "operationsMeetingDailyStats",
  batchSize: 200,
  migrateOne: async (_ctx, row) => {
    throw new Error(`Legacy meeting daily stats remain: ${row._id}`);
  },
});

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
    // The row keeps no copy of the deal's stage (docs/plans/phase-5-deal-status.md §4.8).
    if (
      projection.tenantId !== opportunity.tenantId ||
      projection.leadId !== opportunity.leadId
    ) {
      throw new Error(
        `Opportunity ${opportunity._id} has a stale opportunitySearch projection`,
      );
    }
  },
});

// Phase 6 PR 2: clear deprecated search day keys before the final narrow.
// Patch directly so no projection, event, or aggregate is rewritten.
export const clearOpportunitySearchDayKeys = migrations.define({
  table: "opportunitySearch",
  batchSize: 200,
  migrateOne: async (ctx, row) => {
    if (
      row.activityDayKey !== undefined ||
      row.activityWeekKey !== undefined ||
      row.activityMonthKey !== undefined
    ) {
      await ctx.db.patch("opportunitySearch", row._id, {
        activityDayKey: undefined,
        activityWeekKey: undefined,
        activityMonthKey: undefined,
      });
    }
  },
});

export const assertOpportunitySearchDayKeysCleared = migrations.define({
  table: "opportunitySearch",
  batchSize: 200,
  migrateOne: async (_ctx, row) => {
    if (
      row.activityDayKey !== undefined ||
      row.activityWeekKey !== undefined ||
      row.activityMonthKey !== undefined
    ) {
      throw new Error(`OpportunitySearch ${row._id} still has day keys`);
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

    // The customer fields as the projection derives them from enrollments
    // (docs/plans/phase-4-customers.md §6.1, §8).
    const deals = await loadPersonDeals(ctx, lead.tenantId, lead._id);
    const expected = await customerFieldsFromEnrollments(ctx, lead.tenantId, lead._id, deals);
    const expectedLifecycle = projectedLifecycle(lead, expected.isCustomer);

    if (row.lifecycle !== expectedLifecycle) {
      throw new Error(`Lead ${lead._id} has stale lifecycle projection`);
    }
    if (row.isSearchVisible !== isVisibleLifecycle(expectedLifecycle)) {
      throw new Error(`Lead ${lead._id} has invalid visibility projection`);
    }
    for (const field of [
      "customerStatus",
      "totalPaidMinor",
      "paymentCurrency",
      "convertedAt",
    ] as const) {
      if (row[field] !== expected[field]) {
        throw new Error(`Lead ${lead._id} has stale ${field} projection`);
      }
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

// Each row copies its deal's stage and outcome (from Phase 5 PR 3) and
// closer, or none of them with no deal. Throws naming the event.
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
    const dealStage = qualificationRowStage(opportunity);
    if (
      row.dealStage !== dealStage?.stage ||
      row.dealOutcome !== dealStage?.outcome ||
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
    // The key carries no deal field (docs/plans/phase-5-deal-status.md §4.8).
    const key = bucketKey({ dayKey: meetingDayKey(meeting.scheduledAt), assignedCloserId: meeting.assignedCloserId,
      bookingProgramId: meeting.bookingProgramId, soldProgramId: opportunity.soldProgramId,
      meetingStatus: meeting.status });
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

// Phase 1 (docs/plans/phase-1-foundations.md §9). Team members first, since
// the event links read them:
// npx convex run migrations:run '{"fn":"migrations:backfillUserTeamMembers","next":["migrations:backfillLeadGenWorkerTeamMembers","migrations:backfillDmCloserTeamMembers","migrations:backfillSlackUserTeamMembers"]}'
// then the matching assert* chain, then backfillDomainEventLinks and
// assertDomainEventLinks. Each is idempotent; rerun an assert with "reset".
export const backfillUserTeamMembers = migrations.define({
  table: "users", batchSize: 50,
  migrateOne: async (ctx, user) => { await ensureUserTeamMember(ctx, user._id); },
});
export const backfillLeadGenWorkerTeamMembers = migrations.define({
  table: "leadGenWorkers", batchSize: 50,
  migrateOne: async (ctx, worker) => { await linkLeadGenWorkerTeamMember(ctx, worker._id); },
});
export const backfillDmCloserTeamMembers = migrations.define({
  table: "dmClosers", batchSize: 50,
  migrateOne: async (ctx, dmCloser) => {
    if (!dmCloser.teamMemberId || dmCloser.userId) await linkDmCloserTeamMember(ctx, dmCloser._id);
  },
});
export const backfillSlackUserTeamMembers = migrations.define({
  table: "slackUsers", batchSize: 50,
  migrateOne: async (ctx, slackUser) => {
    if (!slackUser.teamMemberId || slackUser.crmUserId) await linkSlackUserTeamMember(ctx, slackUser._id);
  },
});
async function assertTeamMemberOf(
  ctx: MutationCtx,
  record: { _id: string; tenantId: Id<"tenants">; teamMemberId?: Id<"teamMembers"> },
  expected?: Id<"teamMembers">,
) {
  if (!record.teamMemberId) throw new Error(`${record._id} has no team member`);
  const teamMember = await ctx.db.get("teamMembers", record.teamMemberId);
  if (teamMember?.tenantId !== record.tenantId) throw new Error(`${record._id} has a team member outside its tenant`);
  if (expected && record.teamMemberId !== expected) throw new Error(`${record._id} doesn't share its user's team member`);
}
async function linkedUserTeamMember(ctx: MutationCtx, userId: Id<"users"> | undefined) {
  return userId ? (await ctx.db.get("users", userId))?.teamMemberId : undefined;
}
export const assertUserTeamMembers = migrations.define({
  table: "users", batchSize: 100,
  migrateOne: async (ctx, user) => { await assertTeamMemberOf(ctx, user); },
});
export const assertLeadGenWorkerTeamMembers = migrations.define({
  table: "leadGenWorkers", batchSize: 100,
  migrateOne: async (ctx, worker) => {
    await assertTeamMemberOf(ctx, worker, await linkedUserTeamMember(ctx, worker.userId));
  },
});
export const assertDmCloserTeamMembers = migrations.define({
  table: "dmClosers", batchSize: 100,
  migrateOne: async (ctx, dmCloser) => {
    await assertTeamMemberOf(ctx, dmCloser, await linkedUserTeamMember(ctx, dmCloser.userId));
  },
});
export const assertSlackUserTeamMembers = migrations.define({
  table: "slackUsers", batchSize: 100,
  migrateOne: async (ctx, slackUser) => {
    await assertTeamMemberOf(ctx, slackUser, await linkedUserTeamMember(ctx, slackUser.crmUserId));
  },
});
export const assertTeamMembersHeld = migrations.define({
  table: "teamMembers", batchSize: 100,
  migrateOne: async (ctx, teamMember) => {
    const records = await teamMemberRoleRecords(ctx, teamMember.tenantId, teamMember._id);
    if (Object.values(records).every((rows) => rows.length === 0)) {
      throw new Error(`Team member ${teamMember._id} has no role record`);
    }
    if (records.users.length > 1) throw new Error(`Team member ${teamMember._id} has two logins`);
  },
});

// Small batches: deriving a lead reads its deals, meetings, payments, Slack
// events and lead gen matches. A health check: rerun it with "reset".
export const assertLeadLifecycle = migrations.define({
  table: "leads", batchSize: 25,
  migrateOne: async (ctx, lead) => {
    const problems = await lifecycleProblems(ctx, lead);
    if (problems.length > 0) throw new Error(`Lead ${lead._id}: ${problems.join("; ")}`);
  },
});

// Fills only what is missing: a live event keeps the links it was written with.
export const backfillDomainEventLinks = migrations.define({
  table: "domainEvents", batchSize: 100,
  migrateOne: async (ctx, event) => {
    if (event.leadId !== undefined && event.teamMemberId !== undefined) return;
    const derived = await deriveStoredEventLinks(ctx, event);
    const patch = {
      ...(event.leadId === undefined && derived.leadId ? { leadId: derived.leadId } : {}),
      ...(event.teamMemberId === undefined && derived.teamMemberId ? { teamMemberId: derived.teamMemberId } : {}),
    };
    if (Object.keys(patch).length > 0) await ctx.db.patch("domainEvents", event._id, patch);
  },
});
export const assertDomainEventLinks = migrations.define({
  table: "domainEvents", batchSize: 100,
  migrateOne: async (ctx, event) => {
    const derived = await deriveStoredEventLinks(ctx, event);
    if (!(await storedLeadIdMatches(ctx, event.leadId, derived.leadId))) {
      throw new Error(`Event ${event._id} has lead ${event.leadId}, expected ${derived.leadId}`);
    }
    if (event.teamMemberId !== derived.teamMemberId && derived.teamMemberId !== undefined) {
      throw new Error(`Event ${event._id} has team member ${event.teamMemberId}, expected ${derived.teamMemberId}`);
    }
  },
});

// Phase 3 (docs/plans/phase-3-attribution.md §10). The backfills, the parity
// check and the copy clears ran in production and left with the narrow
// (§3.3). These three asserts stay as health checks, and none writes. Run
// one with "reset" at any time:
// npx convex run migrations:run '{"fn":"migrations:assertPersonTouches","reset":true}'
//   - assertPersonTouches: each person's first and latest touch (§4.5)
//   - assertBookingAttributions: each booking's rows, against its resolution
//   - assertDealAttributions: each deal's lead gen, setter and closer rows

const TOUCH_FIELDS = ["firstTouch", "latestTouch"] as const;
type TouchFields = Partial<Pick<Doc<"leads">, (typeof TOUCH_FIELDS)[number]>>;

/** The touch fields `stored` holds that don't name the computed events. */
function touchMismatches(stored: TouchFields, computed: TouchFields) {
  return TOUCH_FIELDS.filter((field) => !sameTouch(stored[field], computed[field]));
}

function touchEventId(touch: TouchSnapshot | undefined) {
  return touch?.eventId ?? "none";
}

export const assertPersonTouches = migrations.define({
  table: "leads", batchSize: 100,
  migrateOne: async (ctx, lead) => {
    if (lead.status === "merged") return;
    const computed = await computePersonTouches(ctx, { tenantId: lead.tenantId, leadId: lead._id });
    const [field] = touchMismatches(lead, computed);
    if (field) {
      throw new Error(`Lead ${lead._id} has ${field} ${touchEventId(lead[field])}, expected ${touchEventId(computed[field])}`);
    }
  },
});

/**
 * A closer row names its user's team member, except when that user was
 * deleted: the row keeps the user ID, and there is no team member to name
 * (12 meetings in production, booked in 2026-06 with a closer since removed).
 */
async function teamMemberMissing(ctx: MutationCtx, row: DealAttribution) {
  if (row.teamMemberId) return false;
  if (row.role === "closer" && "userId" in row.source) {
    return (await ctx.db.get("users", row.source.userId)) !== null;
  }
  return true;
}

/**
 * Whether the pipeline moved this meeting to a later booking's host
 * (`syncOpportunityMeetingsAssignedCloser`): a booking on the same deal made
 * after it went to the meeting's current closer.
 */
async function movedToLaterHost(ctx: MutationCtx, meeting: Doc<"meetings">) {
  const closerRows = await attributionsForDeal(ctx, meeting.tenantId, meeting.opportunityId, "closer");
  return closerRows.some(
    (row) =>
      row.source.kind === "booking_closer" &&
      row.source.userId === meeting.assignedCloserId &&
      row.meetingId !== meeting._id &&
      row.attributedAt > meeting.createdAt,
  );
}

// One set of rows per booking (§4.9), on the booking's deal and with its
// times, checked against the booking's own resolution: a `mapped` booking
// has its dm_team row and any other has none.
export const assertBookingAttributions = migrations.define({
  table: "meetings", batchSize: 100,
  migrateOne: async (ctx, meeting) => {
    const fail = (problem: string) => new Error(`Meeting ${meeting._id}: ${problem}`);
    const rows = await attributionsForMeeting(ctx, meeting.tenantId, meeting._id);
    for (const row of rows) {
      if (row.opportunityId !== meeting.opportunityId) {
        throw fail(`row ${row._id} is on opportunity ${row.opportunityId}, expected ${meeting.opportunityId}`);
      }
    }
    const teamRows = rows.filter((row) => row.role === "dm_team");
    const dmRows = rows.filter((row) => row.role === "dm_closer");
    const closerRows = rows.filter((row) => row.source.kind === "booking_closer");
    // One set per booking (§4.9); reassignment rows are their own facts.
    if (teamRows.length > 1) throw fail(`${teamRows.length} dm_team rows`);
    if (dmRows.length > 1) throw fail(`${dmRows.length} dm_closer rows`);
    if (closerRows.length !== 1) throw fail(`${closerRows.length} booking_closer rows, expected 1`);
    for (const row of [...teamRows, ...dmRows, ...closerRows]) {
      if (row.meetingScheduledAt !== meeting.scheduledAt || row.attributedAt !== meeting.createdAt) {
        throw fail(`${row.role} row ${row._id} doesn't carry the booking's times`);
      }
    }
    const [team] = teamRows;
    const [dm] = dmRows;
    const [closer] = closerRows;
    if (await teamMemberMissing(ctx, closer)) throw fail(`booking_closer row ${closer._id} has no team member`);
    if (closer.source.kind === "booking_closer") {
      const bookedWith = meeting.reassignedFromCloserId ?? meeting.assignedCloserId;
      if (closer.source.userId !== bookedWith && !(await movedToLaterHost(ctx, meeting))) {
        throw fail(`booking_closer row ${closer._id} names ${closer.source.userId}, expected ${bookedWith}`);
      }
    }
    if (team && (team.source.kind !== "booking_utm" || !team.teamId || team.teamMemberId)) {
      throw fail(`dm_team row ${team._id} isn't a team's booking credit`);
    }
    if (dm) {
      if (dm.source.kind !== "booking_utm" || !dm.source.dmCloserId) throw fail(`dm_closer row ${dm._id} names no DM closer`);
      const dmCloser = await ctx.db.get("dmClosers", dm.source.dmCloserId);
      if (!dm.teamMemberId || dm.teamMemberId !== dmCloser?.teamMemberId) {
        throw fail(`dm_closer row ${dm._id} has team member ${dm.teamMemberId ?? "none"}, expected ${dmCloser?.teamMemberId ?? "none"}`);
      }
      // A DM closer always brings its team.
      if (!team) throw fail(`dm_closer row ${dm._id} has no dm_team row beside it`);
    }
    if ((meeting.attributionResolution === "mapped") !== (team !== undefined)) {
      throw fail(`resolution ${meeting.attributionResolution ?? "unset"} with ${team ? "a" : "no"} dm_team row`);
    }
  },
});

// Far above the qualifications one deal gets; past it the assert stops.
const QUALIFICATIONS_PER_DEAL_LIMIT = 100;

/** The Slack qualifications that credit a deal's setters, oldest first (§4.4). */
async function creditingQualifications(ctx: MutationCtx, opportunity: Doc<"opportunities">) {
  const events = await ctx.db
    .query("slackQualificationEvents")
    .withIndex("by_tenantId_and_opportunityId_and_submittedAt", (q) =>
      q.eq("tenantId", opportunity.tenantId).eq("opportunityId", opportunity._id),
    )
    .take(QUALIFICATIONS_PER_DEAL_LIMIT + 1);
  if (events.length > QUALIFICATIONS_PER_DEAL_LIMIT) {
    throw new Error(`Opportunity ${opportunity._id} has more than ${QUALIFICATIONS_PER_DEAL_LIMIT} qualifications`);
  }
  return events.filter((event) => qualificationCreditsSetter(event.resultKind));
}

/**
 * The setters a deal credits: each crediting qualification's, or, on the
 * Slack deals older than the qualification events, `qualifiedBy`'s.
 */
async function dealSetters(ctx: MutationCtx, opportunity: Doc<"opportunities">) {
  const events = await creditingQualifications(ctx, opportunity);
  if (events.length > 0) {
    return events.map((event) => ({
      slackUserId: event.slackUserId,
      submittedAt: event.submittedAt,
      qualificationEventId: event._id,
    }));
  }
  return opportunity.qualifiedBy
    ? [{ slackUserId: opportunity.qualifiedBy.slackUserId, submittedAt: opportunity.qualifiedBy.submittedAt }]
    : [];
}

const SOURCE_KINDS_BY_ROLE: Record<DealAttribution["role"], readonly DealAttribution["source"]["kind"][]> = {
  lead_gen: ["capture"],
  setter: ["slack_qualification"],
  dm_team: ["booking_utm"],
  dm_closer: ["booking_utm"],
  closer: ["booking_closer", "reassignment", "side_deal"],
};

/** A setter's identity on a deal: its team member, else its Slack user. */

async function slackUserTeamMemberId(ctx: MutationCtx, tenantId: Id<"tenants">, slackUserId: string) {
  const slackUser = await ctx.db
    .query("slackUsers")
    .withIndex("by_tenantId_and_slackUserId", (q) => q.eq("tenantId", tenantId).eq("slackUserId", slackUserId))
    .first();
  return slackUser?.teamMemberId;
}

function captureCredit(row: Pick<DealAttribution, "source" | "teamMemberId">) {
  return JSON.stringify(
    row.source.kind === "capture"
      ? [row.source.prospectId, row.source.workerId, row.source.eventId, row.teamMemberId ?? null]
      : [row.source.kind, row.teamMemberId ?? null],
  );
}

// Checks every row on the deal (a team member on every person's role, and
// references inside the tenant and on this deal), then recomputes its lead
// gen, setter and side deal rows with one fact per identity (§4.9).
export const assertDealAttributions = migrations.define({
  table: "opportunities", batchSize: 100,
  migrateOne: async (ctx, opportunity) => {
    const fail = (problem: string) => new Error(`Opportunity ${opportunity._id}: ${problem}`);
    const rows = await attributionsForDeal(ctx, opportunity.tenantId, opportunity._id);

    const checked = new Set<string>();
    for (const row of rows) {
      if (!SOURCE_KINDS_BY_ROLE[row.role].includes(row.source.kind)) {
        throw fail(`${row.role} row ${row._id} has a ${row.source.kind} source`);
      }
      if (row.role === "dm_team" ? !row.teamId || row.teamMemberId : await teamMemberMissing(ctx, row)) {
        throw fail(row.role === "dm_team"
          ? `dm_team row ${row._id} must name a team and no team member`
          : `${row.role} row ${row._id} has no team member`);
      }
      const references: Array<[string, () => Promise<{ tenantId: Id<"tenants">; opportunityId?: Id<"opportunities"> } | null>]> = [];
      const { teamMemberId, teamId, meetingId, source } = row;
      if (teamMemberId) references.push([`team member ${teamMemberId}`, () => ctx.db.get("teamMembers", teamMemberId)]);
      if (teamId) references.push([`team ${teamId}`, () => ctx.db.get("attributionTeams", teamId)]);
      if (source.kind === "booking_utm" && source.dmCloserId) {
        const dmCloserId = source.dmCloserId;
        references.push([`DM closer ${dmCloserId}`, () => ctx.db.get("dmClosers", dmCloserId)]);
      }
      if (meetingId) references.push([`meeting ${meetingId}`, () => ctx.db.get("meetings", meetingId)]);
      for (const [label, load] of references) {
        if (checked.has(label)) continue;
        const doc = await load();
        if (doc?.tenantId !== opportunity.tenantId) {
          throw fail(`${row.role} row ${row._id} references ${label}, which is missing or outside the tenant`);
        }
        if (doc.opportunityId !== undefined && doc.opportunityId !== opportunity._id) {
          throw fail(`${row.role} row ${row._id} references ${label} of opportunity ${doc.opportunityId}`);
        }
        checked.add(label);
      }
    }

    const leadGenRows = rows.filter((row) => row.role === "lead_gen");
    if (leadGenRows.length > 1) throw fail(`${leadGenRows.length} lead_gen rows`);
    const [leadGen] = leadGenRows;
    const expectedLeadGen = await expectedLeadGenRow(ctx, opportunity);
    if (!leadGen !== !expectedLeadGen) {
      throw fail(`lead_gen row ${leadGen?._id ?? "missing"}, expected ${expectedLeadGen ? "one" : "none"}`);
    }
    if (leadGen && expectedLeadGen && captureCredit(leadGen) !== captureCredit(expectedLeadGen)) {
      throw fail(`lead_gen row ${leadGen._id} credits ${captureCredit(leadGen)}, expected ${captureCredit(expectedLeadGen)}`);
    }

    const setters = rows.flatMap((row) =>
      row.role === "setter" && row.source.kind === "slack_qualification"
        ? [row.teamMemberId ?? `no team member (${row._id})`]
        : [],
    );
    const duplicate = setters.find((key, index) => setters.indexOf(key) !== index);
    if (duplicate) throw fail(`two setter rows for ${duplicate}`);
    const expectedSetters = new Set<string>();
    // A setter with no team member gets no row (recordSetterAttribution).
    for (const setter of await dealSetters(ctx, opportunity)) {
      const teamMemberId = await slackUserTeamMemberId(ctx, opportunity.tenantId, setter.slackUserId);
      if (teamMemberId) expectedSetters.add(teamMemberId);
    }
    const missing = [...expectedSetters].filter((key) => !setters.includes(key));
    const unexpected = setters.filter((key) => !expectedSetters.has(key));
    if (missing.length > 0 || unexpected.length > 0) {
      throw fail(`setters missing ${missing.join(", ") || "none"}, unexpected ${unexpected.join(", ") || "none"}`);
    }

    const sideDealRows = rows.filter((row) => row.source.kind === "side_deal").length;
    const expectedSideDealRows = opportunity.source === "side_deal" && opportunity.assignedCloserId ? 1 : 0;
    if (sideDealRows !== expectedSideDealRows) {
      throw fail(`${sideDealRows} side_deal closer rows, expected ${expectedSideDealRows}`);
    }
  },
});

// Phase 4 (docs/plans/phase-4-customers.md §10.2). The two asserts stay as
// health checks; run them with "reset" at any time. `backfillEnrollments`
// (§10.1) ran before PR 4 and is gone: from PR 4 the enrollment's status is
// no longer copied to the customer row, so a rerun would overwrite a newer
// status with the row's.

// Each enrollment against the payments it derives from and the person it
// belongs to. From PR 4 no customer row is written or kept in step, so none
// is compared.
export const assertEnrollments = migrations.define({
  table: "enrollments", batchSize: 100,
  migrateOne: async (ctx, enrollment) => {
    const { tenantId, leadId, programId } = enrollment;
    const fail = (problem: string) => new Error(`Enrollment ${enrollment._id}: ${problem}`);
    const derived = await derivePersonEnrollments(ctx, tenantId, leadId);
    const expected = derived.find((entry) => entry.programId === programId);
    if (!expected) throw fail(`no payment for person ${leadId} and program ${programId} that isn't disputed`);
    if (expected.opportunityId !== enrollment.opportunityId || expected.enrolledAt !== enrollment.enrolledAt) {
      throw fail(`on ${enrollment.opportunityId} at ${enrollment.enrolledAt}, expected ${expected.opportunityId} at ${expected.enrolledAt}`);
    }
    const sameProgram = await ctx.db
      .query("enrollments")
      .withIndex("by_tenantId_and_leadId_and_programId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId).eq("programId", programId),
      )
      .take(2);
    if (sameProgram.length > 1) throw fail(`person ${leadId} has 2 enrollments for program ${programId}`);
    const lead = await ctx.db.get("leads", leadId);
    if (!lead || lead.tenantId !== tenantId) throw fail(`person ${leadId} is missing`);
    if (lead.status !== "converted") throw fail(`person ${leadId} is ${lead.status}, expected converted`);
  },
});

// The other direction: each payment that counts has its enrollment, which
// starts no later than the payment.
export const assertPaymentEnrollments = migrations.define({
  table: "paymentRecords", batchSize: 100,
  migrateOne: async (ctx, payment) => {
    if (!paymentCounts(payment) || !payment.opportunityId) return;
    const deal = await ctx.db.get("opportunities", payment.opportunityId);
    if (!deal || deal.tenantId !== payment.tenantId) {
      throw new Error(`Payment ${payment._id}: opportunity ${payment.opportunityId} is missing`);
    }
    const enrollment = await getPersonProgramEnrollment(ctx, payment.tenantId, deal.leadId, payment.programId);
    if (!enrollment) {
      throw new Error(`Payment ${payment._id}: no enrollment for person ${deal.leadId} and program ${payment.programId}`);
    }
    if (enrollment.enrolledAt > payment.recordedAt) {
      throw new Error(`Payment ${payment._id} recorded at ${payment.recordedAt}, before enrollment ${enrollment._id} at ${enrollment.enrolledAt}`);
    }
  },
});

// Phase 5, PR 2 (docs/plans/phase-5-deal-status.md §10.5). A cancel fact
// recorded before `calendlyBookingFacts.rescheduled` existed lacks Calendly's
// flag, so the late booking of a reschedule's cancel would cancel its deal.
// These read the flag from the stored cancel and find its fact under the URIs
// the processor records it with (`deliveryMetadata`'s scheduled event, the
// row's invitee). A cancel with no fact is skipped: the fact is written when
// the delivery is processed, flag included. A payload that doesn't parse has
// no event URI, so it is skipped too.

/** The fact of a stored cancel that Calendly flagged `rescheduled`. */
async function rescheduledCancelFact(ctx: MutationCtx, raw: Doc<"rawWebhookEvents">) {
  if (raw.eventType !== "invitee.canceled") return null;
  const { eventUri, payload } = await deliveryMetadata(raw);
  if (!eventUri || payload?.rescheduled !== true) return null;
  return await ctx.db
    .query("calendlyBookingFacts")
    .withIndex("by_tenantId_and_eventUri_and_inviteeUri", (q) =>
      q.eq("tenantId", raw.tenantId).eq("eventUri", eventUri).eq("inviteeUri", raw.calendlyEventUri),
    )
    .unique();
}

export const backfillCancelRescheduledFlags = migrations.define({
  table: "rawWebhookEvents",
  batchSize: 200,
  migrateOne: async (ctx, raw) => {
    const fact = await rescheduledCancelFact(ctx, raw);
    if (fact && fact.rescheduled !== true) {
      await ctx.db.patch("calendlyBookingFacts", fact._id, { rescheduled: true });
    }
  },
});

export const assertCancelRescheduledFlags = migrations.define({
  table: "rawWebhookEvents",
  batchSize: 200,
  migrateOne: async (ctx, raw) => {
    const fact = await rescheduledCancelFact(ctx, raw);
    if (fact && fact.rescheduled !== true) {
      throw new Error(`Raw event ${raw._id}: cancel fact ${fact._id} has no rescheduled flag`);
    }
  },
});

// Phase 5 (docs/plans/phase-5-deal-status.md §10). The backfill, the parity
// queries and the clears have run and are gone, and the narrow dropped the
// status and its copies. assertDealStages stays as a health check; rerun it
// with "reset" at any time. Nothing here emits an event or moves a person's
// stage.

// Each deal's stage allows its outcome (the schema requires both); a deal a
// missed meeting closed (the system's loss, with no person:
// isMissedMeetingLoss) has its loss time; a Follow-up deal has at most one
// pending reschedule link, and a deal at any other stage has none, since a
// booking through a link expires the rest (pipeline/inviteeCreated.ts) and
// only Follow-up waits on one (§10.2). Throws on the first problem, with IDs
// and codes only.
export const assertDealStages = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (ctx, deal) => {
    const fail = (problem: string) => new Error(`Opportunity ${deal._id} ${problem}`);
    const { stage, outcome } = deal;
    if (!isAllowedStageOutcome(stage, outcome)) {
      throw fail(`has stage "${stage}", which doesn't allow outcome "${outcome}"`);
    }
    const missed = isMissedMeetingLoss(deal);
    if (missed && deal.lostAt === undefined) {
      throw fail(`is closed by a missed meeting (${missed}) and has no lostAt`);
    }
    const { count } = await loadPendingRescheduleLink(ctx, deal._id);
    if (stage === "follow_up" ? count > 1 : count > 0) {
      throw fail(`is at ${stage} and has ${count} pending reschedule links`);
    }
  },
});

// Enters every deal in opportunityByStage. Idempotent; the write hooks keep
// it from there, on the strict methods.
export const backfillOpportunityByStage = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (ctx, deal) => {
    await opportunityByStage.insertIfDoesNotExist(ctx, deal);
  },
});

// Phase 6 PR 3: assert before clearing, then verify the clear. Only the four
// origins present in the production snapshot may pass the preflight.
export const assertPaymentsCommissionable = migrations.define({
  table: "paymentRecords",
  batchSize: 200,
  migrateOne: async (_ctx, payment) => {
    if (
      payment.commissionable === false ||
      // The retired origins left the validator; a row still holding one
      // would also fail the schema push.
      (payment.origin as string) === "customer_direct" ||
      (payment.origin as string) === "bookkeeper_direct"
    ) {
      throw new Error(`Payment ${payment._id}`);
    }
  },
});

export const clearPaymentCommissionable = migrations.define({
  table: "paymentRecords",
  batchSize: 200,
  migrateOne: async (ctx, payment) => {
    if (payment.commissionable !== undefined) {
      // No aggregate key, sum or enrollment derivation reads this field.
      await ctx.db.patch("paymentRecords", payment._id, {
        commissionable: undefined,
      });
    }
  },
});

export const assertPaymentCommissionableCleared = migrations.define({
  table: "paymentRecords",
  batchSize: 200,
  migrateOne: async (_ctx, payment) => {
    if (payment.commissionable !== undefined) {
      throw new Error(`Payment ${payment._id}`);
    }
  },
});

export const backfillMeetingAttendance = migrations.define({
  table: "meetings",
  // Neither patch changes scheduledAt or whether the meeting is scheduled,
  // so current refs stay unchanged and their refresh skips search rebuilds.
  // Budget 8 app reads per row (including
  // pagination and ref checks), plus 128 for aggregate delete/insert tree walks
  // and Workpool enqueue at the current 6,918-meeting scale. 16 * (8 + 128)
  // = 2,176 reads, leaving nearly half the 4,096 limit for runner overhead.
  // Confirm that budget in the dry run before starting the production run.
  batchSize: 16,
  migrateOne: async (ctx, meeting) => {
    if (meeting.status === "completed") {
      if (meeting.completedAt === undefined) throw new Error(meeting._id);
      await patchMeetingLifecycle(ctx, meeting._id, {
        status: "held",
        heldMarkedAt: meeting.completedAt,
      });
    } else if (meeting.status !== "held" && meeting.completedAt !== undefined) {
      // No-shows got it from the old writers; a Calendly reversal can leave it
      // on a meeting it moved back to scheduled or to canceled.
      await patchMeetingLifecycle(ctx, meeting._id, { completedAt: undefined });
    }
  },
});

export const assertMeetingAttendance = migrations.define({
  table: "meetings",
  batchSize: 200,
  migrateOne: async (_ctx, meeting) => {
    if (
      meeting.status === "completed" ||
      (meeting.status === "held" && meeting.heldMarkedAt === undefined) ||
      (meeting.status !== "held" && meeting.completedAt !== undefined) ||
      (meeting.status !== "held" && meeting.heldMarkedAt !== undefined)
    ) throw new Error(meeting._id);
  },
});
