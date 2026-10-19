import type { GenericDataModel, TableNamesInDataModel } from "convex/server";
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatiblePaymentCommissionable,
} from "../lib/paymentTypes";
import { ACTIVE_OPPORTUNITY_STATUSES } from "../lib/tenantStatsHelper";
import {
  customerConversions,
  isSlackQualificationAggregateEligible,
  meetingsByStatus,
  opportunityByStatus,
  paymentSums,
  slackQualificationsByTime,
  slackQualificationsByUser,
} from "./aggregates";

type CountableTableName =
  | "customers"
  | "leads"
  | "meetings"
  | "opportunities"
  | "paymentRecords"
  | "tenants";

async function countTableRows<
  TableName extends TableNamesInDataModel<GenericDataModel> & CountableTableName,
>(
  ctx: QueryCtx,
  tableName: TableName,
): Promise<number> {
  let count = 0;

  for await (const row of ctx.db.query(tableName)) {
    void row;
    count += 1;
  }

  return count;
}

function isPaymentAggregateEligible(payment: Doc<"paymentRecords">): boolean {
  return (
    resolveLegacyCompatiblePaymentCommissionable(payment) &&
    resolveLegacyCompatibleAttributedCloserId(payment) !== undefined
  );
}

async function countAggregateRows(
  ctx: QueryCtx,
  aggregate:
    | typeof customerConversions
    | typeof meetingsByStatus
    | typeof opportunityByStatus
    | typeof paymentSums
    | typeof slackQualificationsByTime
    | typeof slackQualificationsByUser,
): Promise<number> {
  let count = 0;

  for await (const tenant of ctx.db.query("tenants")) {
    count += await aggregate.count(ctx, { namespace: tenant._id });
  }

  return count;
}

export const verifyBackfillCounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [
      customerAggregateCount,
      customerTableCount,
      meetingsAggregateCount,
      meetingsTableCount,
      opportunitiesAggregateCount,
      opportunitiesTableCount,
      paymentAggregateCount,
      slackQualificationTimeAggregateCount,
      slackQualificationUserAggregateCount,
      paymentTableCount,
      commissionablePaymentTableCount,
      slackQualificationEligibleTableCount,
      tenantCount,
      unclassifiedMeetings,
    ] = await Promise.all([
      countAggregateRows(ctx, customerConversions),
      countTableRows(ctx, "customers"),
      countAggregateRows(ctx, meetingsByStatus),
      countTableRows(ctx, "meetings"),
      countAggregateRows(ctx, opportunityByStatus),
      countTableRows(ctx, "opportunities"),
      countAggregateRows(ctx, paymentSums),
      countAggregateRows(ctx, slackQualificationsByTime),
      countAggregateRows(ctx, slackQualificationsByUser),
      countTableRows(ctx, "paymentRecords"),
      (async () => {
        let count = 0;
        for await (const payment of ctx.db.query("paymentRecords")) {
          if (isPaymentAggregateEligible(payment)) {
            count += 1;
          }
        }
        return count;
      })(),
      (async () => {
        let count = 0;
        for await (const opportunity of ctx.db.query("opportunities")) {
          if (isSlackQualificationAggregateEligible(opportunity)) {
            count += 1;
          }
        }
        return count;
      })(),
      countTableRows(ctx, "tenants"),
      (async () => {
        let count = 0;
        for await (const meeting of ctx.db.query("meetings")) {
          if (meeting.callClassification === undefined) {
            count += 1;
          }
        }
        return count;
      })(),
    ]);

    return {
      customers: {
        aggregate: customerAggregateCount,
        match: customerAggregateCount === customerTableCount,
        table: customerTableCount,
      },
      meetings: {
        aggregate: meetingsAggregateCount,
        match: meetingsAggregateCount === meetingsTableCount,
        table: meetingsTableCount,
        unclassified: unclassifiedMeetings,
      },
      opportunities: {
        aggregate: opportunitiesAggregateCount,
        match: opportunitiesAggregateCount === opportunitiesTableCount,
        table: opportunitiesTableCount,
      },
      paymentRecords: {
        aggregate: paymentAggregateCount,
        match: paymentAggregateCount === commissionablePaymentTableCount,
        aggregateEligibleTable: commissionablePaymentTableCount,
        table: paymentTableCount,
      },
      slackQualifications: {
        byTimeAggregate: slackQualificationTimeAggregateCount,
        byUserAggregate: slackQualificationUserAggregateCount,
        match:
          slackQualificationTimeAggregateCount ===
            slackQualificationEligibleTableCount &&
          slackQualificationUserAggregateCount ===
            slackQualificationEligibleTableCount,
        aggregateEligibleTable: slackQualificationEligibleTableCount,
      },
      tenantCount,
    };
  },
});

export const verifySlackQualificationAggregate = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_source_and_createdAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("source", "slack_qualified")
          .gte("createdAt", args.startDate)
          .lt("createdAt", args.endDate),
      )
      .take(1000);

    const eligibleRows = rows.filter((row) => {
      const submittedAt = row.qualifiedBy?.submittedAt ?? row.createdAt;
      return (
        row.qualifiedBy !== undefined &&
        submittedAt >= args.startDate &&
        submittedAt < args.endDate
      );
    });

    const aggregate = await slackQualificationsByTime.count(ctx, {
      namespace: args.tenantId,
      bounds: {
        lower: { key: args.startDate, inclusive: true },
        upper: { key: args.endDate, inclusive: false },
      },
    });

    return {
      scannedCount: eligibleRows.length,
      aggregate,
      matches: rows.length < 1000 && aggregate === eligibleRows.length,
      scanTruncated: rows.length >= 1000,
    };
  },
});

const STATUS_COUNTER_STATUSES = {
  activeOpportunities: [...ACTIVE_OPPORTUNITY_STATUSES],
  wonDeals: ["payment_received"],
  lostDeals: ["lost"],
} as const;

export type TenantStatusCounters = {
  activeOpportunities: number;
  wonDeals: number;
  lostDeals: number;
};

/**
 * The tenant counters that follow opportunity status, recounted from the
 * status aggregate. It reads a few aggregate nodes, not the opportunities.
 */
export async function countTenantStatusCounters(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
): Promise<TenantStatusCounters> {
  const count = async (statuses: readonly Doc<"opportunities">["status"][]) => {
    let total = 0;
    for (const status of statuses) {
      total += await opportunityByStatus.count(ctx, {
        namespace: tenantId,
        bounds: { prefix: [status] },
      });
    }
    return total;
  };
  return {
    activeOpportunities: await count(STATUS_COUNTER_STATUSES.activeOpportunities),
    wonDeals: await count(STATUS_COUNTER_STATUSES.wonDeals),
    lostDeals: await count(STATUS_COUNTER_STATUSES.lostDeals),
  };
}

/** Read-only: compares tenantStats with a recount of the status counters. */
export const verifyTenantStatusCounters = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const counted = await countTenantStatusCounters(ctx, tenantId);
    const stats = await ctx.db
      .query("tenantStats")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();
    const stored = {
      activeOpportunities: stats?.activeOpportunities ?? 0,
      wonDeals: stats?.wonDeals ?? 0,
      lostDeals: stats?.lostDeals ?? 0,
    };
    return {
      stored,
      counted,
      match:
        stored.activeOpportunities === counted.activeOpportunities &&
        stored.wonDeals === counted.wonDeals &&
        stored.lostDeals === counted.lostDeals,
    };
  },
});
