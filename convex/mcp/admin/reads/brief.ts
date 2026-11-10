import { gatewayAnswerBytes, MAX_ASSISTANT_ANSWER_BYTES } from "../../../../lib/assistantReportMerge";
import { v } from "convex/values";
import { internalQuery } from "../../../_generated/server";
import { getTenantBusinessDay } from "../../../lib/tenantBusinessDay";
import { readLiveQueryRows } from "../../../lib/liveQueryBounds";
import { getEffectiveRange } from "../../../lib/unavailabilityValidation";
import { deriveOverviewRange } from "../../../dashboard/overviewRange";
import { getPhoneCloserOperationsOverviewSection } from "../../../dashboard/overviewOperations";
import { readSalesCallsDashboard } from "../../../operations/salesCallsDashboardCore";
import { countBillingPayments } from "../../../billing/aggregates";
import { buildBookingReviewCount } from "../../../pipeline/bookingReviewsCore";
import {
  getNonDisputedPaymentsInRange,
  summarizePaymentsForRevenueReporting,
} from "../../../reporting/lib/helpers";
import {
  addBusinessDays,
  businessDateForInstant,
  calendarDate,
} from "../../../../lib/businessDay";
import { rejectRequest } from "../../../lib/observability/errors";
import { mcpCallerValidator, requireMcpAdmin } from "../../guard";
import { formatLocal } from "../../time";
import { appLink } from "../prepare";
import { text, textValidator, partialReason } from "./common";
import { buildQueueSummary, queueSummaryValidator, type Queue } from "./queue";
import { endOfDayStatuses } from "./endOfDay";
import { buildHealth, healthRowValidator, freshnessValidator } from "./health";

export const briefArgs = { date: v.optional(v.string()) };
const moneyValidator = v.object({
  currency: v.string(),
  count: v.number(),
  amountMinor: v.number(),
});
const metricsValidator = v.object({
  calls: v.number(),
  held: v.number(),
  noShow: v.number(),
  canceled: v.number(),
  notRecorded: v.number(),
  toGo: v.number(),
  showRate: v.object({
    value: v.union(v.number(), v.null()),
    numerator: v.number(),
    denominator: v.number(),
  }),
  finalCash: v.array(moneyValidator),
  deposits: v.array(moneyValidator),
});
function money(payments: Array<{ currency: string; amountMinor: number }>) {
  const totals = new Map<
    string,
    { currency: string; count: number; amountMinor: number }
  >();
  for (const p of payments) {
    const currency = p.currency.trim().toUpperCase() || "UNKNOWN",
      r = totals.get(currency) ?? { currency, count: 0, amountMinor: 0 };
    r.count++;
    r.amountMinor += p.amountMinor;
    totals.set(currency, r);
  }
  return [...totals.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}
function counts(
  calls: number,
  held: number,
  noShow: number,
  canceled: number,
  notRecorded: number,
) {
  return {
    calls,
    held,
    noShow,
    canceled,
    notRecorded,
    toGo: Math.max(0, calls - held - noShow - canceled - notRecorded),
    showRate: {
      value: held + noShow ? held / (held + noShow) : null,
      numerator: held,
      denominator: held + noShow,
    },
  };
}
export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...briefArgs },
  returns: v.object({
    status: v.string(),
    date: v.string(),
    timeZone: v.string(),
    businessDay: v.object({ timeZone: v.string(), startHour: v.number() }),
    resolvedRange: v.object({ start: v.string(), end: v.string() }),
    floor: v.union(v.null(), metricsValidator),
    closers: v.array(
      v.object({
        closerId: v.id("users"),
        name: textValidator,
        metrics: metricsValidator,
        endOfDay: v.string(),
        allowedActions: v.array(v.string()),
      }),
    ),
    endOfDayDate: v.string(),
    closersOpenInMagnus: v.string(),
    queues: v.array(queueSummaryValidator),
    out: v.array(
      v.object({
        id: v.id("closerUnavailability"),
        closerId: v.id("users"),
        name: textValidator,
        fullDay: v.boolean(),
        from: v.string(),
        to: v.string(),
        reason: v.string(),
        allowedActions: v.array(v.string()),
        openInMagnus: v.string(),
      }),
    ),
    health: v.array(healthRowValidator),
    freshness: v.object({ liveAsOf: v.string(), reports: freshnessValidator }),
    sources: v.array(v.object({ engine: v.string(), watermark: v.string() })),
    isPartial: v.boolean(),
    reason: v.union(v.string(), v.null()),
    openInMagnus: v.string(),
  }),
  handler: async (ctx, { caller, date: requestedDate }) => {
    const me = await requireMcpAdmin(ctx, caller);
    if (requestedDate !== undefined) {
      try {
        calendarDate(requestedDate);
      } catch {
        throw rejectRequest(
          "mcp.invalid_date",
          "Pass date as a real business date, YYYY-MM-DD.",
        );
      }
    }
    const now = Date.now(),
      day = await getTenantBusinessDay(ctx, me.tenantId),
      date = requestedDate ?? businessDateForInstant(now, day);
    const input = {
        kind: "custom" as const,
        startBusinessDate: date,
        endBusinessDateInclusive: date,
      },
      range = deriveOverviewRange(input, now, day);
    const activeUsers = await readLiveQueryRows(
      ctx.db
        .query("users")
        .withIndex("by_tenantId_and_isActive", (q) =>
          q.eq("tenantId", me.tenantId).eq("isActive", true),
        ),
      300,
    );
    const activeCloserIds = new Set(
      activeUsers.rows.filter((u) => u.role === "closer").map((u) => u._id),
    );
    // A past day's own end-of-day reports; for today or a future day,
    // yesterday's, since no later report is due yet.
    const today = businessDateForInstant(now, day);
    const endOfDayDate = date < today ? date : addBusinessDays(today, -1);
    const endOfDay = await endOfDayStatuses(ctx, me, endOfDayDate);
    const health = await buildHealth(ctx, me);
    const queues = [];
    for (const queue of [
      "payments_to_review",
      "not_recorded",
      "second_opinions",
      "missed_meetings",
      "booking_reviews",
      "unmatched_recordings",
      "team_review",
      "failed_work",
    ] as Queue[])
      queues.push(await buildQueueSummary(ctx, me, queue));
    const paymentQueue = queues.find((q) => q.queue === "payments_to_review")!;
    if (me.tenant.billingOpsEnabled) {
      paymentQueue.count = await countBillingPayments(ctx, me.tenantId, {
        status: "recorded",
      });
      paymentQueue.atLeast = paymentQueue.count;
      paymentQueue.isPartial = false;
    }
    const reviewQueue = queues.find((q) => q.queue === "booking_reviews")!;
    const reviews = await buildBookingReviewCount(ctx, me.tenantId);
    reviewQueue.count = reviews.capped ? null : reviews.count;
    reviewQueue.atLeast = reviews.count;
    reviewQueue.isPartial = reviews.capped;
    const absences = await readLiveQueryRows(
      ctx.db
        .query("closerUnavailability")
        .withIndex("by_tenantId_and_date", (q) =>
          q
            .eq("tenantId", me.tenantId)
            .gte("date", range.operationsStartDate - 86400000)
            .lt("date", range.operationsEndDate),
        ),
      100,
    );
    const relevant = absences.rows.filter((r) => {
      const bounds = getEffectiveRange(r);
      return (
        bounds.rangeStart < range.operationsEndDate &&
        bounds.rangeEnd > range.operationsStartDate
      );
    });
    const out = await Promise.all(
      relevant.slice(0, 25).map(async (r) => {
        const user = await ctx.db.get("users", r.closerId),
          b = getEffectiveRange(r);
        return {
          id: r._id,
          closerId: r.closerId,
          name: text(
            user?.tenantId === me.tenantId
              ? (user.fullName ?? "Unnamed closer")
              : "Removed closer",
            "closer",
          ),
          fullDay: r.isFullDay,
          from: formatLocal(b.rangeStart, me.timeZone),
          to: formatLocal(b.rangeEnd, me.timeZone),
          reason: r.reason,
          allowedActions: [
            "magnus_lookup",
            ...(activeCloserIds.has(r.closerId) &&
            me.writeFamilies.includes("coverage")
              ? ["magnus_cover_closer"]
              : []),
          ],
          openInMagnus: appLink(`/workspace/team/redistribute/${r._id}`),
        };
      }),
    );
    let dashboard: Awaited<ReturnType<typeof readSalesCallsDashboard>> | null =
      null;
    let overview: Awaited<
      ReturnType<typeof getPhoneCloserOperationsOverviewSection>
    > | null = null;
    try {
      overview = await getPhoneCloserOperationsOverviewSection(
        ctx,
        me.tenantId,
        range,
      );
      dashboard = await readSalesCallsDashboard(ctx, me.tenantId, input);
    } catch {
      /* Unverified/rebuilding projections have no trustworthy figures. */
    }
    const paymentScan = await getNonDisputedPaymentsInRange(
        ctx,
        me.tenantId,
        range.operationsStartDate,
        range.operationsEndDate,
      ),
      paymentSummary = summarizePaymentsForRevenueReporting(
        paymentScan.payments,
      );
    let isPartial =
      activeUsers.capped ||
      endOfDay.isPartial ||
      queues.some((q) => q.isPartial) ||
      absences.capped ||
      relevant.length > 25 ||
      !dashboard ||
      dashboard.capped ||
      dashboard.attendanceCountsPartial ||
      paymentScan.isTruncated;
    const closers =
      dashboard?.closers.slice(0, 25).map((c) => ({
        closerId: c.closerId,
        name: text(
          c.label.includes("@") ? "Unnamed closer" : c.label,
          "closer",
        ),
        metrics: {
          ...counts(c.booked, c.showed, c.noShows, c.canceled, c.notRecorded),
          finalCash: c.moneyByCurrency.map((m) => ({
            currency: m.currency,
            count: m.paymentSales,
            amountMinor: m.paymentRevenueMinor,
          })),
          deposits: money(
            paymentSummary.depositPayments.filter(
              (p) => p.effectiveCloserId === c.closerId,
            ),
          ),
        },
        endOfDay: endOfDay.statusOf(c.closerId),
        allowedActions: [
          "magnus_end_of_day",
          "magnus_lookup",
          ...(activeCloserIds.has(c.closerId) &&
          me.writeFamilies.includes("coverage")
            ? ["magnus_cover_closer"]
            : []),
        ],
      })) ?? [];
    isPartial ||= (dashboard?.closers.length ?? 0) > 25;
    const total = overview?.data.totals;
    const floor =
      total &&
      dashboard &&
      !dashboard.capped &&
      !dashboard.attendanceCountsPartial &&
      !paymentScan.isTruncated
        ? {
            ...counts(
              total.scheduled,
              total.held,
              total.noShows,
              dashboard.stats.canceled,
              dashboard.teamTotal.notRecorded,
            ),
            finalCash: dashboard.stats.moneyByCurrency.map((m) => ({
              currency: m.currency,
              count: m.paymentSalesCount,
              amountMinor: m.cashCollectedMinor,
            })),
            deposits: money(paymentSummary.depositPayments),
          }
        : null;
    const result = {
      status: floor ? (isPartial ? "partial" : "ready") : "unavailable",
      date,
      timeZone: me.timeZone,
      businessDay: { timeZone: day.timeZone, startHour: day.dayStartHour },
      resolvedRange: {
        start: formatLocal(range.operationsStartDate, me.timeZone),
        end: formatLocal(range.operationsEndDate, me.timeZone),
      },
      floor,
      closers,
      endOfDayDate,
      closersOpenInMagnus: appLink("/workspace/operations/sales-calls"),
      queues,
      out,
      health: health.rows.filter((r) => r.status !== "ok"),
      freshness: {
        liveAsOf: formatLocal(now, me.timeZone),
        reports: health.freshness,
      },
      sources: [
        { engine: "convex_live", watermark: formatLocal(now, me.timeZone) },
      ],
      isPartial,
      reason: floor
        ? partialReason(isPartial)
        : "Live reporting is rebuilding, unverified, or unavailable. No floor numbers are returned.",
      openInMagnus: appLink("/workspace"),
    };
    while (
      gatewayAnswerBytes(result) > MAX_ASSISTANT_ANSWER_BYTES &&
      (result.closers.length || result.out.length)
    ) {
      if (result.out.length && result.out.length >= result.closers.length)
        result.out.pop();
      else result.closers.pop();
      result.isPartial = true;
      result.reason =
        "The live brief reached its answer-size limit. Open Magnus for the remaining rows.";
      if (result.floor) result.status = "partial";
    }
    return result;
  },
});
