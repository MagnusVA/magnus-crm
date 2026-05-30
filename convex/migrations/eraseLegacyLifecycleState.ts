import { migrations } from "../migrations";
import {
  applyLifecycleRepair,
  deriveMeetingRepair,
  deriveOpportunityRepair,
  isLegacyMeetingStatus,
  isLegacyOpportunityStatus,
  refreshOpportunityStatusProjections,
} from "./legacyLifecycleRepair";
import { replaceOperationsMeetingStats } from "../operations/meetingStats";
import {
  resolveLegacyCompatiblePaymentCommissionable,
  resolvePaymentType,
} from "../lib/paymentTypes";

const LEGACY_MEETING_FIELD_KEYS = [
  "attendanceCheckId",
  "reviewId",
  "overranDetectedAt",
  "startedAt",
  "startedAtSource",
  "stoppedAt",
  "stoppedAtSource",
  "lateStartDurationMs",
  "overranDurationMs",
  "exceededScheduledDurationMs",
  "noShowWaitDurationMs",
] as const;

function hasLegacyOperationsStatus(row: {
  meetingStatus: string;
  opportunityStatus?: string;
}): boolean {
  return (
    row.meetingStatus === "in_progress" ||
    row.meetingStatus === "meeting_overran" ||
    row.opportunityStatus === "in_progress" ||
    row.opportunityStatus === "meeting_overran"
  );
}

function activeOpportunityCountStatus(status: string): boolean {
  return (
    status === "qualified_pending" ||
    status === "scheduled" ||
    status === "follow_up_scheduled" ||
    status === "reschedule_link_sent"
  );
}

function paymentRevenueBucket(payment: {
  commissionable?: boolean;
  contextType: "opportunity" | "customer";
  origin?: string | null;
  paymentType?: "monthly" | "split" | "pif" | "deposit";
}):
  | "totalCommissionableFinalRevenueMinor"
  | "totalCommissionableDepositRevenueMinor"
  | "totalNonCommissionableFinalRevenueMinor"
  | "totalNonCommissionableDepositRevenueMinor" {
  const commissionable = resolveLegacyCompatiblePaymentCommissionable(payment);
  const paymentType = resolvePaymentType(payment.paymentType);

  if (commissionable) {
    return paymentType === "deposit"
      ? "totalCommissionableDepositRevenueMinor"
      : "totalCommissionableFinalRevenueMinor";
  }

  return paymentType === "deposit"
    ? "totalNonCommissionableDepositRevenueMinor"
    : "totalNonCommissionableFinalRevenueMinor";
}

export const stripLegacyLifecycleFields = migrations.define({
  table: "meetings",
  batchSize: 50,
  migrateOne: async (ctx, meeting) => {
    const patch: Record<(typeof LEGACY_MEETING_FIELD_KEYS)[number], undefined> =
      {} as Record<(typeof LEGACY_MEETING_FIELD_KEYS)[number], undefined>;

    if (meeting.attendanceCheckId) {
      try {
        await ctx.scheduler.cancel(meeting.attendanceCheckId);
      } catch (error) {
        console.warn("[Migration:LegacyLifecycle] Attendance check cancel skipped", {
          meetingId: meeting._id,
          attendanceCheckId: meeting.attendanceCheckId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const key of LEGACY_MEETING_FIELD_KEYS) {
      if (meeting[key] !== undefined) {
        patch[key] = undefined;
      }
    }

    return Object.keys(patch).length > 0 ? patch : undefined;
  },
});

export const repairLegacyLifecycleMeetings = migrations.define({
  table: "meetings",
  batchSize: 25,
  migrateOne: async (ctx, meeting) => {
    const opportunity = await ctx.db.get(meeting.opportunityId);
    const hasLegacyMeeting = isLegacyMeetingStatus(meeting.status);
    const hasLegacyOpportunity = isLegacyOpportunityStatus(opportunity?.status);

    if (!hasLegacyMeeting && !hasLegacyOpportunity) {
      return;
    }

    const now = Date.now();
    const repair = await deriveMeetingRepair(ctx, {
      meeting,
      opportunity,
      now,
    });

    await applyLifecycleRepair(ctx, {
      beforeMeeting: meeting,
      meetingPatch: repair.meetingPatch,
      beforeOpportunity: opportunity,
      opportunityPatch: repair.opportunityPatch,
      now,
    });
  },
});

export const repairStandaloneLegacyOpportunities = migrations.define({
  table: "opportunities",
  batchSize: 25,
  migrateOne: async (ctx, opportunity) => {
    if (!isLegacyOpportunityStatus(opportunity.status)) {
      return;
    }

    const now = Date.now();
    const { linkedMeeting, repair } = await deriveOpportunityRepair(
      ctx,
      opportunity,
      now,
    );

    await applyLifecycleRepair(ctx, {
      beforeMeeting: linkedMeeting,
      meetingPatch: linkedMeeting ? repair.meetingPatch : {},
      beforeOpportunity: opportunity,
      opportunityPatch: repair.opportunityPatch,
      now,
    });
  },
});

export const refreshStatusProjections = migrations.define({
  table: "opportunities",
  batchSize: 50,
  migrateOne: async (ctx, opportunity) => {
    await refreshOpportunityStatusProjections(ctx, opportunity._id);
  },
});

export const refreshMeetingOperationsStats = migrations.define({
  table: "meetings",
  batchSize: 50,
  migrateOne: async (ctx, meeting) => {
    const opportunity = await ctx.db.get(meeting.opportunityId);
    const opportunityStatus = opportunity?.status;
    const nextMeeting = {
      ...meeting,
      opportunityStatus,
    };

    if (meeting.opportunityStatus !== opportunityStatus) {
      await ctx.db.patch(meeting._id, { opportunityStatus });
    }

    await replaceOperationsMeetingStats(ctx, meeting, nextMeeting);
  },
});

export const deleteLegacyOperationsMeetingDailyStats = migrations.define({
  table: "operationsMeetingDailyStats",
  batchSize: 50,
  migrateOne: async (ctx, row) => {
    if (hasLegacyOperationsStatus(row) || row.count <= 0) {
      await ctx.db.delete(row._id);
    }
  },
});

export const refreshTenantStats = migrations.define({
  table: "tenants",
  batchSize: 1,
  migrateOne: async (ctx, tenant) => {
    let totalTeamMembers = 0;
    let totalClosers = 0;
    for await (const user of ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))) {
      if (!user.isActive) {
        continue;
      }
      totalTeamMembers += 1;
      if (user.role === "closer") {
        totalClosers += 1;
      }
    }

    let totalOpportunities = 0;
    let activeOpportunities = 0;
    let wonDeals = 0;
    let lostDeals = 0;
    for await (const opportunity of ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))) {
      totalOpportunities += 1;
      if (activeOpportunityCountStatus(opportunity.status)) {
        activeOpportunities += 1;
      }
      if (opportunity.status === "payment_received") {
        wonDeals += 1;
      }
      if (opportunity.status === "lost") {
        lostDeals += 1;
      }
    }

    let totalPaymentRecords = 0;
    let totalRevenueMinor = 0;
    const revenueBuckets = {
      totalCommissionableFinalRevenueMinor: 0,
      totalCommissionableDepositRevenueMinor: 0,
      totalNonCommissionableFinalRevenueMinor: 0,
      totalNonCommissionableDepositRevenueMinor: 0,
    };

    for await (const payment of ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))) {
      if (payment.status === "disputed") {
        continue;
      }

      totalPaymentRecords += 1;
      totalRevenueMinor += payment.amountMinor;
      revenueBuckets[paymentRevenueBucket(payment)] += payment.amountMinor;
    }

    let totalLeads = 0;
    for await (const lead of ctx.db
      .query("leads")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))) {
      if (lead.status === "active") {
        totalLeads += 1;
      }
    }

    let totalCustomers = 0;
    for await (const customer of ctx.db
      .query("customers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))) {
      void customer;
      totalCustomers += 1;
    }

    const payload = {
      totalTeamMembers,
      totalClosers,
      totalOpportunities,
      activeOpportunities,
      wonDeals,
      lostDeals,
      totalRevenueMinor,
      ...revenueBuckets,
      totalPaymentRecords,
      totalLeads,
      totalCustomers,
      lastUpdatedAt: Date.now(),
    };

    const existingStats = await ctx.db
      .query("tenantStats")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))
      .unique();

    if (existingStats) {
      await ctx.db.patch(existingStats._id, payload);
      return;
    }

    await ctx.db.insert("tenantStats", {
      tenantId: tenant._id,
      ...payload,
    });
  },
});

export const deleteMeetingReviews = migrations.define({
  table: "meetingReviews",
  batchSize: 50,
  migrateOne: async (ctx, row) => {
    await ctx.db.delete(row._id);
  },
});
