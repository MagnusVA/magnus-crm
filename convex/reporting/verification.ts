import type { GenericDataModel, TableNamesInDataModel } from "convex/server";
import { internalQuery } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import {
  customerConversions,
  leadTimeline,
  meetingsByStatus,
  opportunityByStatus,
  paymentSums,
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

async function countAggregateRows(
  ctx: QueryCtx,
  aggregate:
    | typeof customerConversions
    | typeof leadTimeline
    | typeof meetingsByStatus
    | typeof opportunityByStatus
    | typeof paymentSums,
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
      paymentTableCount,
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
      countTableRows(ctx, "paymentRecords"),
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
        match: paymentAggregateCount === paymentTableCount,
        table: paymentTableCount,
      },
      tenantCount,
    };
  },
});
