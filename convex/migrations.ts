import { Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api";
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
      await ctx.db.patch(opportunity._id, patch);
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

    const lead = await ctx.db.get(opportunity.leadId);
    const installations = await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId", (q) =>
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
      await ctx.db.patch(opportunity._id, {
        qualifiedAt: opportunity.qualifiedBy.submittedAt,
      });
    }
    await rebuildQualificationRow(ctx, eventId);
  },
});

export const backfillMeetingOpportunityStatusAndOperationsStats =
  migrations.define({
    table: "meetings",
    batchSize: 100,
    migrateOne: async (ctx, meeting) => {
      const opportunity = await ctx.db.get(meeting.opportunityId);
      const opportunityStatus = opportunity?.status;
      const nextMeeting = { ...meeting, opportunityStatus };

      if (meeting.opportunityStatus !== opportunityStatus) {
        await ctx.db.patch(meeting._id, { opportunityStatus });
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
      await ctx.db.patch(stat._id, {
        scheduledHours,
        updatedAt: Date.now(),
      });
    }
  },
});
