import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { PAYMENT_TYPES, type PaymentType } from "../../lib/paymentTypes";
import {
  buildRevenueDetails,
  buildRevenueMetrics,
  type getRevenueDetails,
  type getRevenueMetrics,
} from "../../reporting/revenue";
import { buildRevenueTrend, type getRevenueTrend } from "../../reporting/revenueTrend";
import { buildBookedVsSoldMatrix, type getBookedVsSoldMatrix } from "../../reporting/bookedVsSold";
import type { SqlRow } from "../clickhouse";
import {
  defineReport,
  optionalEnumFilter,
  optionalIdFilter,
  rangeParams,
  type AnalyticsFilters,
  type ReportInput,
} from "../definition";
import { docsFromRows } from "../rows";

// Revenue (app/workspace/reports/revenue). Every panel reads the range's
// non-disputed payments, so ClickHouse returns those rows and the Convex
// builders do the rest: both sources run the same code, and the 2,500-payment
// cap of the Convex scan doesn't apply.

type RevenueFilters = {
  programId: Id<"tenantPrograms"> | null;
  paymentType: PaymentType | null;
};

type TrendFilters = RevenueFilters & { granularity: "day" | "week" | "month" };

async function parseRevenueFilters(ctx: QueryCtx, raw: AnalyticsFilters): Promise<RevenueFilters> {
  return {
    programId: optionalIdFilter(ctx, "tenantPrograms", raw.programId),
    paymentType: optionalEnumFilter(raw.paymentType, PAYMENT_TYPES),
  };
}

function paymentsSql(input: ReportInput<RevenueFilters>) {
  return {
    payments: {
      sql: `
SELECT *
FROM analytics.payments
WHERE tenant_id = {tenant_id:String}
  AND recorded_at_ms >= {from_ms:Int64}
  AND recorded_at_ms < {to_ms:Int64}
  AND ifNull(status, '') != 'disputed'`,
      params: rangeParams(input.range),
    },
  };
}

function paymentScan(rows: Record<string, SqlRow[]>) {
  return { payments: docsFromRows<"paymentRecords">(rows.payments), isTruncated: false };
}

function liveArgs(input: ReportInput<RevenueFilters>) {
  return {
    startDate: input.range.fromMs,
    endDate: input.range.toMs,
    ...(input.filters.programId ? { programId: input.filters.programId } : {}),
    ...(input.filters.paymentType ? { paymentType: input.filters.paymentType } : {}),
  };
}

const roles = ["tenant_master", "tenant_admin"] as const;

export const revenueReports = [
  defineReport<typeof getRevenueMetrics, RevenueFilters>({
    id: "revenue.metrics",
    page: "revenue",
    roles,
    day: "browser",
    parseFilters: parseRevenueFilters,
    sql: paymentsSql,
    finalize: async (ctx, input) =>
      await buildRevenueMetrics(ctx, input.tenantId, input.filters, paymentScan(input.rows)),
    live: { name: "reporting/revenue:getRevenueMetrics", args: liveArgs },
  }),
  defineReport<typeof getRevenueDetails, RevenueFilters>({
    id: "revenue.details",
    page: "revenue",
    roles,
    day: "browser",
    parseFilters: parseRevenueFilters,
    sql: paymentsSql,
    finalize: async (ctx, input) =>
      await buildRevenueDetails(ctx, input.filters, paymentScan(input.rows)),
    live: { name: "reporting/revenue:getRevenueDetails", args: liveArgs },
  }),
  defineReport<typeof getRevenueTrend, TrendFilters>({
    id: "revenue.trend",
    page: "revenue",
    roles,
    day: "browser",
    parseFilters: async (ctx, raw) => ({
      ...(await parseRevenueFilters(ctx, raw)),
      granularity: optionalEnumFilter(raw.granularity, ["day", "week", "month"] as const) ?? "day",
    }),
    sql: paymentsSql,
    finalize: async (ctx, input) =>
      await buildRevenueTrend(
        ctx,
        input.tenantId,
        {
          ...input.filters,
          startDate: input.range.fromMs,
          endDate: input.range.toMs,
        },
        paymentScan(input.rows),
      ),
    live: {
      name: "reporting/revenueTrend:getRevenueTrend",
      args: (input) => ({ ...liveArgs(input), granularity: input.filters.granularity }),
    },
  }),
  defineReport<typeof getBookedVsSoldMatrix, RevenueFilters>({
    id: "revenue.booked_vs_sold",
    page: "revenue",
    roles,
    day: "browser",
    parseFilters: parseRevenueFilters,
    sql: paymentsSql,
    finalize: async (ctx, input) =>
      await buildBookedVsSoldMatrix(
        ctx,
        input.tenantId,
        { paymentProgramId: input.filters.programId, paymentType: input.filters.paymentType },
        paymentScan(input.rows),
      ),
    live: {
      name: "reporting/bookedVsSold:getBookedVsSoldMatrix",
      args: (input) => ({
        startDate: input.range.fromMs,
        endDate: input.range.toMs,
        ...(input.filters.programId ? { paymentProgramId: input.filters.programId } : {}),
        ...(input.filters.paymentType ? { paymentType: input.filters.paymentType } : {}),
      }),
    },
  }),
];
