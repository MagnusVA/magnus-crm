import type { GenericDataModel, TableNamesInDataModel } from "convex/server";
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatiblePaymentCommissionable,
} from "../lib/paymentTypes";
import {
  customerConversions,
  isSlackQualificationAggregateEligible,
  leadTimeline,
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
    | typeof leadTimeline
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
      leadAggregateCount,
      leadTableCount,
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
      countAggregateRows(ctx, leadTimeline),
      countTableRows(ctx, "leads"),
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
      leads: {
        aggregate: leadAggregateCount,
        match: leadAggregateCount === leadTableCount,
        table: leadTableCount,
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
