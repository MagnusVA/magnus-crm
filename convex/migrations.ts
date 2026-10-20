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
  dealBookingCredit,
  expectedLeadGenRow,
  qualificationCreditsSetter,
  recordBookingAttribution,
  recordCloserReassignment,
  recordDealCreation,
  recordSetterAttribution,
  type BookingCredit,
  type DealAttribution,
} from "./lib/attribution/dealAttributions";
import { deriveStoredEventLinks, storedLeadIdMatches } from "./lib/domainEventLinks";
import { lifecycleProblems } from "./lib/leadLifecycle";
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
  isVisibleLifecycle,
  projectedLifecycle,
  rebuildLeadCustomerSearchRow,
} from "./leadCustomers/projection";
import { upsertOpportunitySearchProjection } from "./lib/opportunitySearch";
import {
  insertOperationsMeetingStats,
  replaceOperationsMeetingStats,
} from "./operations/meetingStats";
import { rebuildQualificationRow } from "./operations/projections";
import {
  expireStaleSlackOpportunity,
  isStaleSlackBacklog,
} from "./slack/staleExpiry";
import {
  computeDealTouches,
  computePersonTouches,
  sameTouch,
  snapshotDealTouches,
  type TouchSnapshot,
} from "./lib/touches";

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
    const expectedLifecycle = projectedLifecycle(lead, customer !== null);

    if (row.lifecycle !== expectedLifecycle) {
      throw new Error(`Lead ${lead._id} has stale lifecycle projection`);
    }
    if (row.isSearchVisible !== isVisibleLifecycle(expectedLifecycle)) {
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

// Phase 3 (docs/plans/phase-3-attribution.md §10). For each backfill a dry
// run, the run, then its assert, in this order:
// npx convex run migrations:run '{"fn":"migrations:backfillPersonTouches","dryRun":true}'
//   1. backfillPersonTouches, assertPersonTouches
//   2. backfillDealTouches, assertDealTouches
//   3. backfillBookingAttributions, assertBookingAttributions
//   4. backfillDealAttributions, assertDealAttributions
//   5. assertQualificationAttributionParity, then the read-only queries in
//      attribution/parity.ts
// None emits an event, moves a stage or changes a counter. Each backfill
// skips what is already written, so a rerun or a resumed batch adds nothing
// (§4.9). Rerun an assert with "reset".

const TOUCH_FIELDS = ["firstTouch", "latestTouch"] as const;
type TouchFields = Partial<Pick<Doc<"leads">, (typeof TOUCH_FIELDS)[number]>>;

/** The touch fields `stored` holds that don't name the computed events. */
function touchMismatches(stored: TouchFields, computed: TouchFields) {
  return TOUCH_FIELDS.filter((field) => !sameTouch(stored[field], computed[field]));
}

function touchEventId(touch: TouchSnapshot | undefined) {
  return touch?.eventId ?? "none";
}

export const backfillPersonTouches = migrations.define({
  table: "leads", batchSize: 100,
  migrateOne: async (ctx, lead) => {
    if (lead.status === "merged") return;
    const computed = await computePersonTouches(ctx, { tenantId: lead.tenantId, leadId: lead._id });
    const patch: TouchFields = {};
    for (const field of touchMismatches(lead, computed)) patch[field] = computed[field];
    // Only the touch fields: `updatedAt` stays, so the search rows don't move.
    if (Object.keys(patch).length > 0) await ctx.db.patch("leads", lead._id, patch);
  },
});
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

export const backfillDealTouches = migrations.define({
  table: "opportunities", batchSize: 100,
  migrateOne: async (ctx, opportunity) => {
    if (!opportunity.firstTouch && !opportunity.latestTouch) await snapshotDealTouches(ctx, opportunity._id);
  },
});
export const assertDealTouches = migrations.define({
  table: "opportunities", batchSize: 100,
  migrateOne: async (ctx, opportunity) => {
    const missing = TOUCH_FIELDS.filter((field) => !opportunity[field]);
    if (missing.length > 0) {
      throw new Error(`Opportunity ${opportunity._id} has no touch snapshot for ${missing.join(" and ")}`);
    }
    const computed = await computeDealTouches(ctx, opportunity);
    const [field] = touchMismatches(opportunity, computed);
    if (field) {
      throw new Error(`Opportunity ${opportunity._id} has ${field} ${touchEventId(opportunity[field])}, expected ${touchEventId(computed[field])}`);
    }
  },
});

function isBookingRow(row: DealAttribution) {
  return row.source.kind === "booking_utm" || row.source.kind === "booking_closer";
}

/** When the meeting was last reassigned to its closer, else its booking time. */
async function reassignedToCloserAt(ctx: MutationCtx, meeting: Doc<"meetings">) {
  const reassignments = await ctx.db
    .query("meetingReassignments")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
    .take(50);
  let at: number | undefined;
  for (const reassignment of reassignments) {
    if (reassignment.tenantId === meeting.tenantId && reassignment.toCloserId === meeting.assignedCloserId) {
      at = Math.max(at ?? reassignment.reassignedAt, reassignment.reassignedAt);
    }
  }
  return at ?? meeting.createdAt;
}

// The booking rows of §4.1 from each meeting's copied team and DM closer.
// The meetings never resolved have no copy and get only their closer row
// (D11).
export const backfillBookingAttributions = migrations.define({
  table: "meetings", batchSize: 100,
  migrateOne: async (ctx, meeting) => {
    const existing = await attributionsForMeeting(ctx, meeting.tenantId, meeting._id);
    if (existing.some(isBookingRow)) return;
    // Reassigned before the rows existed: the booking went to the closer it
    // came from, and a reassignment row moves it on.
    const fromUserId = meeting.reassignedFromCloserId;
    const reassigned = fromUserId !== undefined && fromUserId !== meeting.assignedCloserId;
    await recordBookingAttribution(ctx, {
      meeting,
      credit: { teamId: meeting.attributionTeamId, dmCloserId: meeting.dmCloserId },
      closerUserId: reassigned ? fromUserId : undefined,
    });
    const moved = existing.some(
      (row) => row.source.kind === "reassignment" && row.source.userId === meeting.assignedCloserId,
    );
    if (reassigned && !moved) {
      await recordCloserReassignment(ctx, {
        tenantId: meeting.tenantId,
        opportunityId: meeting.opportunityId,
        meeting,
        toUserId: meeting.assignedCloserId,
        fromUserId,
        at: await reassignedToCloserAt(ctx, meeting),
      });
    }
  },
});

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

// Checks the copies while the meeting has them, and the resolution always,
// so it still holds after PR 6 clears the copies: a `mapped` booking has its
// dm_team row and any other has none.
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
    if (!closer.teamMemberId) throw fail(`booking_closer row ${closer._id} has no team member`);
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

    // The copies, while the meeting still has them.
    if (meeting.attributionTeamId && team?.teamId !== meeting.attributionTeamId) {
      throw fail(`dm_team row credits ${team?.teamId ?? "no team"}, the copy ${meeting.attributionTeamId}`);
    }
    const dmCloserCredited = dm?.source.kind === "booking_utm" ? dm.source.dmCloserId : undefined;
    if (meeting.dmCloserId && dmCloserCredited !== meeting.dmCloserId) {
      throw fail(`dm_closer row credits ${dmCloserCredited ?? "no DM closer"}, the copy ${meeting.dmCloserId}`);
    }
    if (meeting.attributionTeamId && !meeting.dmCloserId && dm) {
      throw fail(`dm_closer row ${dm._id} on a booking whose copy names no DM closer`);
    }

    // The resolution, which the meeting keeps after the copies go.
    if ((meeting.attributionResolution === "mapped") !== (team !== undefined)) {
      throw fail(`resolution ${meeting.attributionResolution ?? "unset"} with ${team ? "a" : "no"} dm_team row`);
    }
  },
});

// Far above the qualifications one deal gets; past it the backfill stops.
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

// The lead gen, setter and side deal rows of §4.2 to §4.4. Run after
// backfillDealTouches: the lead gen row reads the deal's snapshot.
export const backfillDealAttributions = migrations.define({
  table: "opportunities", batchSize: 100,
  migrateOne: async (ctx, opportunity) => {
    await recordDealCreation(ctx, opportunity._id);
    for (const setter of await dealSetters(ctx, opportunity)) {
      await recordSetterAttribution(ctx, { tenantId: opportunity.tenantId, opportunityId: opportunity._id, ...setter });
    }
  },
});

const SOURCE_KINDS_BY_ROLE: Record<DealAttribution["role"], readonly DealAttribution["source"]["kind"][]> = {
  lead_gen: ["capture"],
  setter: ["slack_qualification"],
  dm_team: ["booking_utm"],
  dm_closer: ["booking_utm"],
  closer: ["booking_closer", "reassignment", "side_deal"],
};

/** A setter's identity on a deal: its team member, else its Slack user. */
function setterKey(teamMemberId: Id<"teamMembers"> | undefined, slackUserId: string) {
  return teamMemberId ?? `slack user ${slackUserId}`;
}

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
// gen, setter and side deal rows with one fact per identity (§4.9), and,
// while the deal has its copy, checks it against its first booking's rows.
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
      if (row.role === "dm_team" ? !row.teamId || row.teamMemberId : !row.teamMemberId) {
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
        ? [setterKey(row.teamMemberId, row.source.slackUserId)]
        : [],
    );
    const duplicate = setters.find((key, index) => setters.indexOf(key) !== index);
    if (duplicate) throw fail(`two setter rows for ${duplicate}`);
    const expectedSetters = new Set<string>();
    for (const setter of await dealSetters(ctx, opportunity)) {
      expectedSetters.add(
        setterKey(await slackUserTeamMemberId(ctx, opportunity.tenantId, setter.slackUserId), setter.slackUserId),
      );
    }
    const missing = [...expectedSetters].filter((key) => !setters.includes(key));
    const unexpected = setters.filter((key) => !expectedSetters.has(key));
    if (missing.length > 0 || unexpected.length > 0) {
      throw fail(`setters missing ${missing.join(", ") || "none"}, unexpected ${unexpected.join(", ") || "none"}`);
    }

    // The deal's copy, while it has one, is its first booking's credit: the
    // detail readers' fallback for a meeting that was never resolved.
    if (opportunity.attributionTeamId || opportunity.dmCloserId) {
      const credit = await dealBookingCredit(ctx, opportunity);
      if (
        (credit.teamId ?? null) !== (opportunity.attributionTeamId ?? null) ||
        (credit.dmCloserId ?? null) !== (opportunity.dmCloserId ?? null)
      ) {
        throw fail(
          `the copy credits team ${opportunity.attributionTeamId ?? "none"} and DM closer ${opportunity.dmCloserId ?? "none"}, ` +
            `the first booking's rows team ${credit.teamId ?? "none"} and DM closer ${credit.dmCloserId ?? "none"}`,
        );
      }
    }

    const sideDealRows = rows.filter((row) => row.source.kind === "side_deal").length;
    const expectedSideDealRows = opportunity.source === "side_deal" && opportunity.assignedCloserId ? 1 : 0;
    if (sideDealRows !== expectedSideDealRows) {
      throw fail(`${sideDealRows} side_deal closer rows, expected ${expectedSideDealRows}`);
    }
  },
});

// The qualifications queue's labels and badge, from the deal's first booking
// (§6.2), against the copy each qualification row holds (§10.4).
export const assertQualificationAttributionParity = migrations.define({
  table: "operationsQualificationRows", batchSize: 100,
  migrateOne: async (ctx, row) => {
    const opportunity = row.opportunityId ? await ctx.db.get("opportunities", row.opportunityId) : null;
    const deal = opportunity?.tenantId === row.tenantId ? opportunity : null;
    const credit: BookingCredit = deal ? await dealBookingCredit(ctx, deal) : {};
    const firstMeeting = deal?.firstMeetingId ? await ctx.db.get("meetings", deal.firstMeetingId) : null;
    const copy = {
      teamId: row.attributionTeamId ?? null,
      dmCloserId: row.dmCloserId ?? null,
      resolution: row.attributionResolution,
    };
    const fromRows = {
      teamId: credit.teamId ?? null,
      dmCloserId: credit.dmCloserId ?? null,
      resolution: firstMeeting?.attributionResolution ?? "none",
    };
    if (copy.teamId !== fromRows.teamId || copy.dmCloserId !== fromRows.dmCloserId || copy.resolution !== fromRows.resolution) {
      throw new Error(`Qualification row ${row._id}: the copy has ${JSON.stringify(copy)}, the rows ${JSON.stringify(fromRows)}`);
    }
  },
});
