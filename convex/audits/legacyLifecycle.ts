import { query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  FINAL_MEETING_STATUSES,
  FINAL_OPPORTUNITY_STATUSES,
  isLegacyMeetingStatus,
  isLegacyOpportunityStatus,
} from "../migrations/legacyLifecycleRepair";
import { meetingDayKey } from "../operations/meetingStats";
import {
  meetingsByStatus,
  opportunityByStatus,
} from "../reporting/aggregates";
import {
  resolveLegacyCompatiblePaymentCommissionable,
  resolvePaymentType,
} from "../lib/paymentTypes";

const CALL_CLASSIFICATIONS = ["new", "follow_up"] as const;
const MAX_MISMATCHES = 100;

type CountMap = Map<string, number>;

type LifecycleMismatch = {
  kind: string;
  status?: string;
  expected?: number | string | null;
  actual?: number | string | null;
  sourceCount?: number;
  aggregateCount?: number;
};

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

function pushMismatch(
  mismatches: LifecycleMismatch[],
  mismatch: LifecycleMismatch,
) {
  if (mismatches.length < MAX_MISMATCHES) {
    mismatches.push(mismatch);
  }
}

function increment(map: CountMap, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function optionalKey(value: string | undefined): string {
  return value ?? "";
}

function operationStatsKey(row: {
  tenantId: Id<"tenants">;
  dayKey: string;
  assignedCloserId: Id<"users">;
  bookingProgramId?: Id<"tenantPrograms">;
  soldProgramId?: Id<"tenantPrograms">;
  attributionTeamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
  opportunityStatus?: string;
  meetingStatus: string;
}): string {
  return [
    row.tenantId,
    row.dayKey,
    row.assignedCloserId,
    optionalKey(row.bookingProgramId),
    optionalKey(row.soldProgramId),
    optionalKey(row.attributionTeamId),
    optionalKey(row.dmCloserId),
    optionalKey(row.opportunityStatus),
    row.meetingStatus,
  ].join("|");
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

function isActiveFinalOpportunityStatus(status: string): boolean {
  return (
    status === "qualified_pending" ||
    status === "scheduled" ||
    status === "follow_up_scheduled" ||
    status === "reschedule_link_sent"
  );
}

function hasLegacyMeetingField(meeting: Doc<"meetings">): boolean {
  return LEGACY_MEETING_FIELD_KEYS.some((key) => meeting[key] !== undefined);
}

function isActiveScheduledFunction(row: {
  name: string;
  state: { kind: string };
}): boolean {
  return (
    row.name.includes("checkMeetingAttendance") &&
    (row.state.kind === "pending" || row.state.kind === "inProgress")
  );
}

async function countOpportunitiesForStatus(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  status: Doc<"opportunities">["status"],
): Promise<number> {
  let count = 0;
  for await (const opportunity of ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_status", (q) =>
      q.eq("tenantId", tenantId).eq("status", status),
    )) {
    void opportunity;
    count += 1;
  }
  return count;
}

async function countMeetingsForStatus(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  status: Doc<"meetings">["status"],
): Promise<number> {
  let count = 0;
  for await (const meeting of ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
      q.eq("tenantId", tenantId).eq("status", status),
    )) {
    void meeting;
    count += 1;
  }
  return count;
}

async function loadAggregateUserIdsForTenant(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
): Promise<Id<"users">[]> {
  const userIds = new Set<Id<"users">>();
  for await (const user of ctx.db
    .query("users")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
    userIds.add(user._id);
  }

  for await (const meeting of ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_scheduledAt", (q) =>
      q.eq("tenantId", tenantId),
    )) {
    userIds.add(meeting.assignedCloserId);
  }

  return [...userIds];
}

async function countMeetingsByStatusAggregate(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    userIds: Id<"users">[];
    status: Doc<"meetings">["status"];
  },
): Promise<number> {
  let total = 0;
  for (const userId of args.userIds) {
    for (const classification of CALL_CLASSIFICATIONS) {
      total += await meetingsByStatus.count(ctx, {
        namespace: args.tenantId,
        bounds: { prefix: [userId, classification, args.status] },
      });
    }
  }
  return total;
}

async function compareOpportunitySearchProjection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  mismatches: LifecycleMismatch[],
): Promise<number> {
  let mismatchCount = 0;

  for await (const opportunity of ctx.db
    .query("opportunities")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
    const projection = await ctx.db
      .query("opportunitySearch")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", opportunity._id),
      )
      .unique();

    if (!projection || projection.status !== opportunity.status) {
      mismatchCount += 1;
      pushMismatch(mismatches, {
        kind: "opportunitySearch",
        expected: opportunity.status,
        actual: projection?.status ?? null,
      });
    }
  }

  return mismatchCount;
}

async function compareMeetingOpportunityStatusProjection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  mismatches: LifecycleMismatch[],
): Promise<number> {
  let mismatchCount = 0;

  for await (const meeting of ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_scheduledAt", (q) =>
      q.eq("tenantId", tenantId),
    )) {
    const opportunity = await ctx.db.get(meeting.opportunityId);
    const expected = opportunity?.status;
    if (meeting.opportunityStatus !== expected) {
      mismatchCount += 1;
      pushMismatch(mismatches, {
        kind: "meetings.opportunityStatus",
        expected: expected ?? null,
        actual: meeting.opportunityStatus ?? null,
      });
    }
  }

  return mismatchCount;
}

async function compareQualificationRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  mismatches: LifecycleMismatch[],
): Promise<number> {
  let mismatchCount = 0;

  for await (const row of ctx.db
    .query("operationsQualificationRows")
    .withIndex("by_tenantId_and_qualifiedAt", (q) =>
      q.eq("tenantId", tenantId),
    )) {
    if (!row.opportunityId) {
      continue;
    }

    const opportunity = await ctx.db.get(row.opportunityId);
    const expected = opportunity?.status;
    if (row.opportunityStatus !== expected) {
      mismatchCount += 1;
      pushMismatch(mismatches, {
        kind: "operationsQualificationRows.opportunityStatus",
        expected: expected ?? null,
        actual: row.opportunityStatus ?? null,
      });
    }
  }

  return mismatchCount;
}

async function compareOperationsMeetingDailyStats(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  mismatches: LifecycleMismatch[],
): Promise<number> {
  const sourceBuckets: CountMap = new Map();
  const storedBuckets: CountMap = new Map();

  for await (const meeting of ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_scheduledAt", (q) =>
      q.eq("tenantId", tenantId),
    )) {
    const opportunity = await ctx.db.get(meeting.opportunityId);
    increment(
      sourceBuckets,
      operationStatsKey({
        tenantId: meeting.tenantId,
        dayKey: meetingDayKey(meeting.scheduledAt),
        assignedCloserId: meeting.assignedCloserId,
        bookingProgramId: meeting.bookingProgramId,
        soldProgramId: meeting.soldProgramId,
        attributionTeamId: meeting.attributionTeamId,
        dmCloserId: meeting.dmCloserId,
        opportunityStatus: opportunity?.status ?? meeting.opportunityStatus,
        meetingStatus: meeting.status,
      }),
      1,
    );
  }

  for await (const row of ctx.db
    .query("operationsMeetingDailyStats")
    .withIndex("by_tenantId_and_dayKey", (q) => q.eq("tenantId", tenantId))) {
    increment(storedBuckets, operationStatsKey(row), row.count);
  }

  const keys = new Set([...sourceBuckets.keys(), ...storedBuckets.keys()]);
  let mismatchCount = 0;
  for (const key of keys) {
    const expected = sourceBuckets.get(key) ?? 0;
    const actual = storedBuckets.get(key) ?? 0;
    if (expected === actual) {
      continue;
    }

    mismatchCount += 1;
    pushMismatch(mismatches, {
      kind: "operationsMeetingDailyStats",
      expected,
      actual,
    });
  }

  return mismatchCount;
}

async function expectedTenantStats(ctx: QueryCtx, tenantId: Id<"tenants">) {
  let totalTeamMembers = 0;
  let totalClosers = 0;
  for await (const user of ctx.db
    .query("users")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
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
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
    totalOpportunities += 1;
    if (isActiveFinalOpportunityStatus(opportunity.status)) {
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
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
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
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
    if (lead.status === "active") {
      totalLeads += 1;
    }
  }

  let totalCustomers = 0;
  for await (const customer of ctx.db
    .query("customers")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
    void customer;
    totalCustomers += 1;
  }

  return {
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
  };
}

async function compareTenantStats(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  mismatches: LifecycleMismatch[],
): Promise<number> {
  const expected = await expectedTenantStats(ctx, tenantId);
  const actual = await ctx.db
    .query("tenantStats")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .unique();

  if (!actual) {
    pushMismatch(mismatches, {
      kind: "tenantStats",
      actual: null,
      expected: "present",
    });
    return 1;
  }

  let mismatchCount = 0;
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[field as keyof typeof expected] ?? 0;
    if (actualValue === expectedValue) {
      continue;
    }

    mismatchCount += 1;
    pushMismatch(mismatches, {
      kind: `tenantStats.${field}`,
      expected: expectedValue,
      actual: actualValue,
    });
  }

  return mismatchCount;
}

export const countLegacyLifecycleRows = query({
  args: {},
  handler: async (ctx) => {
    const counts = {
      meetings: 0,
      meetingOpportunityStatus: 0,
      meetingLegacyFields: 0,
      opportunities: 0,
      opportunitySearch: 0,
      operationsMeetingDailyStatsMeetingStatus: 0,
      operationsMeetingDailyStatsOpportunityStatus: 0,
      operationsQualificationRows: 0,
      meetingReviews: 0,
      scheduledAttendanceChecks: 0,
    };

    for await (const meeting of ctx.db.query("meetings")) {
      if (isLegacyMeetingStatus(meeting.status)) {
        counts.meetings += 1;
      }
      if (isLegacyOpportunityStatus(meeting.opportunityStatus)) {
        counts.meetingOpportunityStatus += 1;
      }
      if (hasLegacyMeetingField(meeting)) {
        counts.meetingLegacyFields += 1;
      }
    }

    for await (const opportunity of ctx.db.query("opportunities")) {
      if (isLegacyOpportunityStatus(opportunity.status)) {
        counts.opportunities += 1;
      }
    }

    for await (const projection of ctx.db.query("opportunitySearch")) {
      if (isLegacyOpportunityStatus(projection.status)) {
        counts.opportunitySearch += 1;
      }
    }

    for await (const row of ctx.db.query("operationsMeetingDailyStats")) {
      if (isLegacyMeetingStatus(row.meetingStatus)) {
        counts.operationsMeetingDailyStatsMeetingStatus += 1;
      }
      if (isLegacyOpportunityStatus(row.opportunityStatus)) {
        counts.operationsMeetingDailyStatsOpportunityStatus += 1;
      }
    }

    for await (const row of ctx.db.query("operationsQualificationRows")) {
      if (isLegacyOpportunityStatus(row.opportunityStatus)) {
        counts.operationsQualificationRows += 1;
      }
    }

    for await (const row of ctx.db.query("meetingReviews")) {
      void row;
      counts.meetingReviews += 1;
    }

    for await (const scheduled of ctx.db.system.query("_scheduled_functions")) {
      if (isActiveScheduledFunction(scheduled)) {
        counts.scheduledAttendanceChecks += 1;
      }
    }

    return counts;
  },
});

export const compareLifecycleAggregates = query({
  args: {},
  handler: async (ctx) => {
    const mismatches: LifecycleMismatch[] = [];
    const mismatchCounts = {
      opportunityByStatus: 0,
      meetingsByStatus: 0,
      opportunitySearch: 0,
      meetingOpportunityStatus: 0,
      operationsQualificationRows: 0,
      operationsMeetingDailyStats: 0,
      tenantStats: 0,
    };

    for await (const tenant of ctx.db.query("tenants")) {
      const userIds = await loadAggregateUserIdsForTenant(ctx, tenant._id);

      for (const status of FINAL_OPPORTUNITY_STATUSES) {
        const sourceCount = await countOpportunitiesForStatus(
          ctx,
          tenant._id,
          status,
        );
        const aggregateCount = await opportunityByStatus.count(ctx, {
          namespace: tenant._id,
          bounds: { prefix: [status] },
        });

        if (sourceCount !== aggregateCount) {
          mismatchCounts.opportunityByStatus += 1;
          pushMismatch(mismatches, {
            kind: "opportunityByStatus",
            status,
            sourceCount,
            aggregateCount,
          });
        }
      }

      for (const status of FINAL_MEETING_STATUSES) {
        const sourceCount = await countMeetingsForStatus(ctx, tenant._id, status);
        const aggregateCount = await countMeetingsByStatusAggregate(ctx, {
          tenantId: tenant._id,
          userIds,
          status,
        });

        if (sourceCount !== aggregateCount) {
          mismatchCounts.meetingsByStatus += 1;
          pushMismatch(mismatches, {
            kind: "meetingsByStatus",
            status,
            sourceCount,
            aggregateCount,
          });
        }
      }

      mismatchCounts.opportunitySearch +=
        await compareOpportunitySearchProjection(ctx, tenant._id, mismatches);
      mismatchCounts.meetingOpportunityStatus +=
        await compareMeetingOpportunityStatusProjection(
          ctx,
          tenant._id,
          mismatches,
        );
      mismatchCounts.operationsQualificationRows += await compareQualificationRows(
        ctx,
        tenant._id,
        mismatches,
      );
      mismatchCounts.operationsMeetingDailyStats +=
        await compareOperationsMeetingDailyStats(ctx, tenant._id, mismatches);
      mismatchCounts.tenantStats += await compareTenantStats(
        ctx,
        tenant._id,
        mismatches,
      );
    }

    const totalMismatchCount = Object.values(mismatchCounts).reduce(
      (sum, count) => sum + count,
      0,
    );

    return {
      ok: totalMismatchCount === 0,
      totalMismatchCount,
      mismatchCounts,
      truncated: mismatches.length >= MAX_MISMATCHES,
      mismatches,
    };
  },
});
