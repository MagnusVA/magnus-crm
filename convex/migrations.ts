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
import type { DataModel, Id } from "./_generated/dataModel";
import { deriveStoredEventLinks, storedLeadIdMatches } from "./lib/domainEventLinks";
import { advanceLeadLifecycle, lifecycleProblems } from "./lib/leadLifecycle";
import { eventsForRecord } from "./lib/domainEvents";
import { normalizeSocialHandle } from "./lib/normalization";
import {
  PORTAL_NOTE_ADDED,
  PORTAL_PROFILE_UPDATED,
  emitPortalTouch,
} from "./linkPortal/portalTouches";
import { prospectConversionProblems } from "./lib/prospectConversions";
import {
  LEAD_CAPTURED,
  LEAD_CAPTURE_VOIDED,
  emitCaptureEvent,
  emitCaptureVoidedEvent,
  linkProspectPerson,
  submissionEvents,
} from "./leadGen/prospectPeople";
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
import { SLACK_QUALIFIED, emitSlackQualifiedTouch } from "./slack/createQualifiedLead";
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

// Phase 2 (docs/plans/phase-2-person-first.md §10). Run one at a time, in
// order: linkProspectPeople (dry run first), assertProspectPeople,
// backfillCaptureEvents, assertCaptureEvents, then assertLeadLifecycle with
// "reset". The narrow removes these four.

// Small batches: a new person writes the lead, its identifier, search row,
// stage entry and six conversion entries.
export const linkProspectPeople = migrations.define({
  table: "leadGenProspects", batchSize: 50,
  migrateOne: async (ctx, prospect) => {
    if (!prospect.leadId) await linkProspectPerson(ctx, prospect._id);
  },
});

async function prospectPersonProblems(
  ctx: MutationCtx,
  prospect: DataModel["leadGenProspects"]["document"],
): Promise<string[]> {
  if (!prospect.leadId) return ["no person"];
  const lead = await ctx.db.get("leads", prospect.leadId);
  if (!lead || lead.tenantId !== prospect.tenantId) return [`person ${prospect.leadId} is missing or in another tenant`];
  const problems: string[] = [];
  if (lead.status === "merged") problems.push(`person ${lead._id} is merged`);
  const handle = normalizeSocialHandle(prospect.normalizedHandle, "instagram");
  if (handle) {
    const identifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_tenantId_and_type_and_value", (q) =>
        q.eq("tenantId", prospect.tenantId).eq("type", "instagram").eq("value", handle),
      )
      .take(10);
    const match = prospect.currentAuditMatchId
      ? await ctx.db.get("leadGenAuditMatches", prospect.currentAuditMatchId)
      : null;
    const holdsHandle = identifiers.some((identifier) => identifier.leadId === lead._id);
    const isMatchLead = match?.matchStatus === "accepted" && match.leadId === lead._id;
    if (!holdsHandle && !isMatchLead) problems.push(`person ${lead._id} neither holds the handle nor is the audit match's lead`);
  }
  if ((lead.lifecycleStageEnteredAt.prospect ?? Number.POSITIVE_INFINITY) > prospect.firstCapturedAt) {
    problems.push(`person ${lead._id} entered Prospect after the first capture`);
  }
  problems.push(...(await prospectConversionProblems(ctx, prospect, lead)));
  return problems;
}

export const assertProspectPeople = migrations.define({
  table: "leadGenProspects", batchSize: 100,
  migrateOne: async (ctx, prospect) => {
    const problems = await prospectPersonProblems(ctx, prospect);
    if (problems.length > 0) throw new Error(`Prospect ${prospect._id}: ${problems.join("; ")}`);
  },
});

// Writes past events, so PostHog is skipped. Run after linkProspectPeople.
export const backfillCaptureEvents = migrations.define({
  table: "leadGenSubmissions", batchSize: 200,
  migrateOne: async (ctx, submission) => {
    const prospect = await ctx.db.get("leadGenProspects", submission.prospectId);
    if (!prospect?.leadId) return;
    if ((await submissionEvents(ctx, submission, LEAD_CAPTURED, submission.submittedAt)).length === 0) {
      await emitCaptureEvent(ctx, submission, prospect.leadId, { skipAnalytics: true });
    }
    if (
      submission.voidedAt !== undefined &&
      (await submissionEvents(ctx, submission, LEAD_CAPTURE_VOIDED, submission.voidedAt)).length === 0
    ) {
      await emitCaptureVoidedEvent(ctx, submission, prospect.leadId, { skipAnalytics: true });
    }
  },
});

export const assertCaptureEvents = migrations.define({
  table: "leadGenSubmissions", batchSize: 200,
  migrateOne: async (ctx, submission) => {
    const prospect = await ctx.db.get("leadGenProspects", submission.prospectId);
    if (!prospect?.leadId) throw new Error(`Submission ${submission._id}: prospect has no person`);
    const checks: Array<[typeof LEAD_CAPTURED | typeof LEAD_CAPTURE_VOIDED, number | undefined]> = [
      [LEAD_CAPTURED, submission.submittedAt],
      [LEAD_CAPTURE_VOIDED, submission.voidedAt],
    ];
    for (const [eventType, at] of checks) {
      if (at === undefined) continue;
      const events = await submissionEvents(ctx, submission, eventType, at);
      if (events.length !== 1) throw new Error(`Submission ${submission._id}: ${events.length} ${eventType} events`);
      if (!(await storedLeadIdMatches(ctx, events[0].leadId, prospect.leadId))) {
        throw new Error(`Submission ${submission._id}: ${eventType} event names ${events[0].leadId}, not ${prospect.leadId}`);
      }
    }
  },
});

// Phase 2 PR 3 (§10.3): the portal notes and edits written before they were
// touches. The copies made before then name no person (D7). Run
// backfillPortalNoteTouches with next ["migrations:backfillPortalEditTouches"],
// then the two asserts, then assertLeadLifecycle with "reset".
async function backfillPortalTouch(
  ctx: MutationCtx,
  record: { _id: string; tenantId: Id<"tenants">; leadId: Id<"leads">; dmCloserId?: Id<"dmClosers"> },
  eventType: typeof PORTAL_NOTE_ADDED | typeof PORTAL_PROFILE_UPDATED,
  at: number,
  metadata: Record<string, unknown>,
) {
  const field = eventType === PORTAL_NOTE_ADDED ? "noteId" : "editId";
  const existing = await eventsForRecord(ctx, {
    tenantId: record.tenantId, eventType, occurredAt: at, field, value: record._id,
  });
  if (existing.length > 0) return;
  const dmCloser = record.dmCloserId ? await ctx.db.get("dmClosers", record.dmCloserId) : null;
  if (!dmCloser) throw new Error(`${record._id} has no DM closer`);
  await advanceLeadLifecycle(ctx, record.leadId, { stage: "in_conversation", at, cause: "dm_portal" });
  await emitPortalTouch(ctx, {
    tenantId: record.tenantId, leadId: record.leadId, dmCloser, eventType, at,
    metadata: { [field]: record._id, ...metadata }, skipAnalytics: true,
  });
}

async function assertPortalTouch(
  ctx: MutationCtx,
  record: { _id: string; tenantId: Id<"tenants">; leadId: Id<"leads"> },
  eventType: typeof PORTAL_NOTE_ADDED | typeof PORTAL_PROFILE_UPDATED,
  at: number,
) {
  const events = await eventsForRecord(ctx, {
    tenantId: record.tenantId, eventType, occurredAt: at,
    field: eventType === PORTAL_NOTE_ADDED ? "noteId" : "editId", value: record._id,
  });
  if (events.length !== 1) throw new Error(`${record._id}: ${events.length} ${eventType} events`);
  if (!(await storedLeadIdMatches(ctx, events[0].leadId, record.leadId))) {
    throw new Error(`${record._id}: ${eventType} event names ${events[0].leadId}, not ${record.leadId}`);
  }
}

export const backfillPortalNoteTouches = migrations.define({
  table: "leadNotes", batchSize: 100,
  migrateOne: async (ctx, note) => {
    if (note.authorKind === "dm_closer") await backfillPortalTouch(ctx, note, PORTAL_NOTE_ADDED, note.createdAt, {});
  },
});
export const backfillPortalEditTouches = migrations.define({
  table: "linkPortalLeadEdits", batchSize: 100,
  migrateOne: async (ctx, edit) => {
    await backfillPortalTouch(ctx, edit, PORTAL_PROFILE_UPDATED, edit.createdAt, { changedFields: edit.changedFields });
  },
});
export const assertPortalNoteTouches = migrations.define({
  table: "leadNotes", batchSize: 100,
  migrateOne: async (ctx, note) => {
    if (note.authorKind === "dm_closer") await assertPortalTouch(ctx, note, PORTAL_NOTE_ADDED, note.createdAt);
  },
});
export const assertPortalEditTouches = migrations.define({
  table: "linkPortalLeadEdits", batchSize: 100,
  migrateOne: async (ctx, edit) => {
    await assertPortalTouch(ctx, edit, PORTAL_PROFILE_UPDATED, edit.createdAt);
  },
});

// Phase 2 PR 4 (§10.4): a touch for each Slack qualification written before
// they were touches. Then assertSlackTouches, and assertDomainEventLinks with
// "reset" over every event.
async function slackTouches(ctx: MutationCtx, event: DataModel["slackQualificationEvents"]["document"]) {
  return await eventsForRecord(ctx, {
    tenantId: event.tenantId, eventType: SLACK_QUALIFIED, occurredAt: event.submittedAt,
    field: "qualificationEventId", value: event._id,
  });
}
export const backfillSlackTouches = migrations.define({
  table: "slackQualificationEvents", batchSize: 100,
  migrateOne: async (ctx, event) => {
    if (!event.leadId || (await slackTouches(ctx, event)).length > 0) return;
    const setter = await ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId_and_slackUserId", (q) => q.eq("tenantId", event.tenantId).eq("slackUserId", event.slackUserId))
      .first();
    await emitSlackQualifiedTouch(ctx, {
      tenantId: event.tenantId, leadId: event.leadId, qualificationEventId: event._id,
      opportunityId: event.opportunityId, resultKind: event.resultKind,
      setterTeamMemberId: setter?.teamMemberId, at: event.submittedAt, skipAnalytics: true,
    });
  },
});
export const assertSlackTouches = migrations.define({
  table: "slackQualificationEvents", batchSize: 100,
  migrateOne: async (ctx, event) => {
    if (!event.leadId) return;
    const touches = await slackTouches(ctx, event);
    if (touches.length !== 1) throw new Error(`Slack event ${event._id}: ${touches.length} ${SLACK_QUALIFIED} events`);
    if (!(await storedLeadIdMatches(ctx, touches[0].leadId, event.leadId))) {
      throw new Error(`Slack event ${event._id}: touch names ${touches[0].leadId}, not ${event.leadId}`);
    }
  },
});
