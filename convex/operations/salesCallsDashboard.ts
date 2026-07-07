import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import {
  deriveOverviewRange,
  overviewRangeValidator,
} from "../dashboard/overviewRange";
import {
  attributionResolutionValidator,
  bookingProgramMappingStatusValidator,
} from "../lib/attribution/validators";
import { memberAvatarIdentityValidator } from "../lib/memberIdentity";
import { opportunityStatusValidator } from "../opportunities/validators";
import {
  getActiveClosers,
  getNonDisputedPaymentsInRange,
  getUserDisplayName,
  reportingUserIdentity,
  splitPaymentsForRevenueReporting,
  summarizeAttributedPayments,
} from "../reporting/lib/helpers";
import { requireTenantUser } from "../requireTenantUser";
import { enrichPhoneSalesRows } from "./phoneSales";

// Matches getPhoneSalesStats / overviewOperations: the daily-stats rollup read
// is bounded and the result is flagged as capped past this many rows.
const MAX_OPERATIONS_STATS_ROWS = 1000;
// Search fan-out bounds — same values as bookedCallsDashboard.
const SEARCH_OPPORTUNITY_LIMIT = 30;
const MEETINGS_PER_OPPORTUNITY_LIMIT = 25;
const SEARCH_RESULT_LIMIT = 50;
// The dashboard window is capped at MAX_OVERVIEW_CUSTOM_DAYS (120) business
// days, which is always under a year of wall-clock time. Rejecting anything
// larger keeps client-supplied epoch-ms bounds from turning into an unbounded
// index range.
const MAX_DETAILS_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

const meetingStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("completed"),
  v.literal("canceled"),
  v.literal("no_show"),
);

const closerTotalsFields = {
  booked: v.number(),
  canceled: v.number(),
  noShows: v.number(),
  showed: v.number(),
  showUpRate: v.union(v.number(), v.null()),
  paymentSales: v.number(),
  paymentRevenueMinor: v.number(),
  paymentCloseRate: v.union(v.number(), v.null()),
  avgPaymentDealMinor: v.union(v.number(), v.null()),
};

const closerRowValidator = v.object({
  closerId: v.id("users"),
  label: v.string(),
  avatar: memberAvatarIdentityValidator,
  ...closerTotalsFields,
});

// Same row shape as listPhoneSalesMeetings pages (enrichPhoneSalesRows), so
// the paginated list and the search results render through one component.
const salesCallsMeetingRowValidator = v.object({
  meetingId: v.id("meetings"),
  opportunityId: v.id("opportunities"),
  leadId: v.union(v.id("leads"), v.null()),
  leadName: v.string(),
  scheduledAt: v.number(),
  meetingStatus: meetingStatusValidator,
  opportunityStatus: v.union(opportunityStatusValidator, v.null()),
  bookingProgramName: v.union(v.string(), v.null()),
  bookingProgramMappingStatus: v.union(
    bookingProgramMappingStatusValidator,
    v.null(),
  ),
  soldProgramName: v.union(v.string(), v.null()),
  assignedCloserName: v.string(),
  assignedCloser: memberAvatarIdentityValidator,
  attributionResolution: attributionResolutionValidator,
  attributionTeamName: v.union(v.string(), v.null()),
  dmCloserName: v.union(v.string(), v.null()),
  dmCloser: v.union(memberAvatarIdentityValidator, v.null()),
  slackUserId: v.union(v.string(), v.null()),
  slackUserLabel: v.union(v.string(), v.null()),
  slackUser: v.union(memberAvatarIdentityValidator, v.null()),
});

type MeetingTotals = {
  booked: number;
  canceled: number;
  noShows: number;
  showed: number;
};

function emptyMeetingTotals(): MeetingTotals {
  return { booked: 0, canceled: 0, noShows: 0, showed: 0 };
}

function addStatsRow(totals: MeetingTotals, row: Doc<"operationsMeetingDailyStats">) {
  totals.booked += row.count;
  if (row.meetingStatus === "completed") totals.showed += row.count;
  if (row.meetingStatus === "canceled") totals.canceled += row.count;
  if (row.meetingStatus === "no_show") totals.noShows += row.count;
}

function toRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function withRates(totals: MeetingTotals & { paymentSales: number; paymentRevenueMinor: number }) {
  // Show-up rate: completed / (all counted meetings - canceled), the exact
  // getPhoneSalesStats formula (= teamPerformance's confirmed-attendance
  // denominator). Close rate: payment sales / showed, teamPerformance's
  // overallCloseRate definition.
  return {
    ...totals,
    showUpRate: toRate(totals.showed, totals.booked - totals.canceled),
    paymentCloseRate: toRate(totals.paymentSales, totals.showed),
    avgPaymentDealMinor:
      totals.paymentSales > 0
        ? totals.paymentRevenueMinor / totals.paymentSales
        : null,
  };
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function uniqueIds<T extends string>(ids: Array<T | undefined>): T[] {
  return [...new Set(ids.filter((id): id is T => id !== undefined))];
}

function compareLabels(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function validateWindow(start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) {
    throw new Error("Invalid sales-calls window bounds.");
  }
  if (end <= start) {
    throw new Error("Sales-calls window end must be after its start.");
  }
  if (end - start > MAX_DETAILS_WINDOW_MS) {
    throw new Error("Sales-calls window is too large. Narrow the date range.");
  }
  return { start, end };
}

/**
 * Consolidated data source for the admin Sales Calls page (NIM-20, "Phone
 * Sales Ops"): stat cards, per-program breakdown, and the phone-closer table
 * with a team-total row, all in one round trip.
 *
 * Population semantics match getPhoneSalesStats exactly: the
 * operationsMeetingDailyStats rollup keyed by the UTC day of `scheduledAt`
 * (dayKey), all four meeting statuses counted. `totalCalls` here is what
 * getPhoneSalesStats calls `scheduled`. Payments follow the
 * teamPerformance/revenue definition of cash collected: non-disputed,
 * commissionable, non-deposit (final) payments by `recordedAt`.
 *
 * The view list stays on listPhoneSalesMeetings — pass `window.start/end`
 * into its scheduledFrom/scheduledTo args so both surfaces share one time
 * window (the epoch bounds are the UTC midnights of the same day keys, so
 * the populations line up exactly).
 */
export const getSalesCallsDashboard = query({
  args: {
    range: overviewRangeValidator,
  },
  returns: v.object({
    stats: v.object({
      totalCalls: v.number(),
      showed: v.number(),
      canceled: v.number(),
      noShows: v.number(),
      showUpRate: v.union(v.number(), v.null()),
      cashCollectedMinor: v.number(),
      paymentSalesCount: v.number(),
      closeRate: v.union(v.number(), v.null()),
      avgCashPerSaleMinor: v.union(v.number(), v.null()),
    }),
    perProgram: v.array(
      v.object({
        programId: v.union(v.id("tenantPrograms"), v.null()),
        label: v.string(),
        calls: v.number(),
        showed: v.number(),
        paymentSales: v.number(),
        paymentRevenueMinor: v.number(),
      }),
    ),
    closers: v.array(closerRowValidator),
    teamTotal: v.object(closerTotalsFields),
    window: v.object({
      start: v.number(),
      end: v.number(),
    }),
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    try {
      const range = deriveOverviewRange(args.range, Date.now());

      const [rawStatsRows, activeClosers, paymentScan] = await Promise.all([
        ctx.db
          .query("operationsMeetingDailyStats")
          .withIndex("by_tenantId_and_dayKey", (q) =>
            q
              .eq("tenantId", tenantId)
              .gte("dayKey", range.operationsStartDayKey)
              .lt("dayKey", range.operationsEndDayKeyExclusive),
          )
          .take(MAX_OPERATIONS_STATS_ROWS + 1),
        getActiveClosers(ctx, tenantId),
        getNonDisputedPaymentsInRange(
          ctx,
          tenantId,
          range.operationsStartDate,
          range.operationsEndDate,
        ),
      ]);

      const statsTruncated = rawStatsRows.length > MAX_OPERATIONS_STATS_ROWS;
      const statsRows = rawStatsRows.slice(0, MAX_OPERATIONS_STATS_ROWS);

      // One rollup read powers the stat cards, the per-program meeting counts,
      // and the per-closer meeting counts, so the three sections can never
      // disagree with each other (or with the legacy phone-sales stat cards).
      const overallMeetings = emptyMeetingTotals();
      const meetingsByCloser = new Map<Id<"users">, MeetingTotals>();
      const meetingsByProgram = new Map<
        Id<"tenantPrograms"> | null,
        MeetingTotals
      >();
      for (const row of statsRows) {
        addStatsRow(overallMeetings, row);

        const closerTotals =
          meetingsByCloser.get(row.assignedCloserId) ?? emptyMeetingTotals();
        addStatsRow(closerTotals, row);
        meetingsByCloser.set(row.assignedCloserId, closerTotals);

        const programKey = row.bookingProgramId ?? null;
        const programTotals =
          meetingsByProgram.get(programKey) ?? emptyMeetingTotals();
        addStatsRow(programTotals, row);
        meetingsByProgram.set(programKey, programTotals);
      }

      // Cash collected: non-disputed, commissionable, final (non-deposit)
      // payments — the same slice teamPerformance and the closer dashboard
      // call cash collected, and reporting/revenue.ts calls
      // commissionable.finalRevenueMinor.
      const paymentSplit = splitPaymentsForRevenueReporting(paymentScan.payments);
      const finalPayments = paymentSplit.commissionable.finalPayments;
      const paymentSummary = summarizeAttributedPayments(finalPayments);

      // Per-program payments use the payment's own programId (the "payment
      // program" dimension, exactly like the Revenue report's byProgram).
      const paymentsByProgram = new Map<
        Id<"tenantPrograms">,
        { sales: number; revenueMinor: number; fallbackName: string | null }
      >();
      for (const payment of finalPayments) {
        const current = paymentsByProgram.get(payment.programId) ?? {
          sales: 0,
          revenueMinor: 0,
          fallbackName: null,
        };
        current.sales += 1;
        current.revenueMinor += payment.amountMinor;
        current.fallbackName = current.fallbackName ?? payment.programName ?? null;
        paymentsByProgram.set(payment.programId, current);
      }

      // Program labels — bounded by the tenant's program registry.
      const programIds = uniqueIds<Id<"tenantPrograms">>([
        ...[...meetingsByProgram.keys()].map((id) => id ?? undefined),
        ...paymentsByProgram.keys(),
      ]);
      const programDocs = await Promise.all(
        programIds.map((id) => ctx.db.get(id)),
      );
      const programNameById = new Map(
        programDocs
          .filter(isNonNull)
          .filter((program) => program.tenantId === tenantId)
          .map((program) => [program._id, program.name]),
      );

      const perProgramKeys = new Set<Id<"tenantPrograms"> | null>([
        ...meetingsByProgram.keys(),
        ...paymentsByProgram.keys(),
      ]);
      const perProgram = [...perProgramKeys]
        .map((programId) => {
          const meetings = meetingsByProgram.get(programId);
          const payments =
            programId === null ? undefined : paymentsByProgram.get(programId);
          return {
            programId,
            label:
              programId === null
                ? "No program"
                : (programNameById.get(programId) ??
                  payments?.fallbackName ??
                  "Unknown program"),
            calls: meetings?.booked ?? 0,
            showed: meetings?.showed ?? 0,
            paymentSales: payments?.sales ?? 0,
            paymentRevenueMinor: payments?.revenueMinor ?? 0,
          };
        })
        .sort(
          (left, right) =>
            right.paymentRevenueMinor - left.paymentRevenueMinor ||
            right.calls - left.calls ||
            compareLabels(left.label, right.label),
        );

      // Closer rows: every active closer (zero rows included, like
      // teamPerformance) plus any closer that appears in the meeting rollup or
      // in payment attribution (so removed/deactivated closers keep their
      // history visible, like getTeamOperationsDimensions).
      const userById = new Map<Id<"users">, Doc<"users">>(
        activeClosers.map((closer) => [closer._id, closer]),
      );
      const closerIds = new Set<Id<"users">>([
        ...userById.keys(),
        ...meetingsByCloser.keys(),
        ...paymentSummary.byCloser.keys(),
      ]);
      for (const closerId of closerIds) {
        if (userById.has(closerId)) continue;
        const user = await ctx.db.get(closerId);
        if (user && user.tenantId === tenantId) {
          userById.set(user._id, user);
        }
      }

      const closers = await Promise.all(
        [...closerIds].map(async (closerId) => {
          const user = userById.get(closerId) ?? null;
          const meetings = meetingsByCloser.get(closerId) ?? emptyMeetingTotals();
          const payments = paymentSummary.byCloser.get(closerId) ?? {
            dealCount: 0,
            revenueMinor: 0,
          };

          return {
            closerId,
            label: user ? getUserDisplayName(user) : "Removed closer",
            avatar: await reportingUserIdentity(ctx, user, "Removed closer"),
            ...withRates({
              ...meetings,
              paymentSales: payments.dealCount,
              paymentRevenueMinor: payments.revenueMinor,
            }),
          };
        }),
      );
      closers.sort(
        (left, right) =>
          right.paymentRevenueMinor - left.paymentRevenueMinor ||
          right.booked - left.booked ||
          compareLabels(left.label, right.label),
      );

      // Team total: sums of the closer rows, rates recomputed from the sums.
      const teamSums = closers.reduce(
        (acc, closer) => ({
          booked: acc.booked + closer.booked,
          canceled: acc.canceled + closer.canceled,
          noShows: acc.noShows + closer.noShows,
          showed: acc.showed + closer.showed,
          paymentSales: acc.paymentSales + closer.paymentSales,
          paymentRevenueMinor:
            acc.paymentRevenueMinor + closer.paymentRevenueMinor,
        }),
        {
          ...emptyMeetingTotals(),
          paymentSales: 0,
          paymentRevenueMinor: 0,
        },
      );

      // Stat cards: meeting counts are the tenant-wide rollup totals;
      // cash collected / sales count are ALL commissionable final payments in
      // the window (including closer-unattributed ones), matching the Revenue
      // report. The team-total row can therefore be lower than the cards when
      // unattributed payments exist.
      const showed = overallMeetings.showed;
      return {
        stats: {
          totalCalls: overallMeetings.booked,
          showed,
          canceled: overallMeetings.canceled,
          noShows: overallMeetings.noShows,
          showUpRate: toRate(
            showed,
            overallMeetings.booked - overallMeetings.canceled,
          ),
          cashCollectedMinor: paymentSummary.totalRevenueMinor,
          paymentSalesCount: paymentSummary.totalDealCount,
          closeRate: toRate(paymentSummary.totalDealCount, showed),
          avgCashPerSaleMinor:
            paymentSummary.totalDealCount > 0
              ? paymentSummary.totalRevenueMinor / paymentSummary.totalDealCount
              : null,
        },
        perProgram,
        closers,
        teamTotal: withRates(teamSums),
        window: {
          start: range.operationsStartDate,
          end: range.operationsEndDate,
        },
        capped: statsTruncated || paymentScan.isTruncated,
      };
    } catch (error) {
      console.error("[Operations:SalesCalls] getSalesCallsDashboard failed", {
        tenantId,
        range: args.range,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

/**
 * Search phone-sales meetings by lead/prospect name for the collapsible view
 * list. Patterned exactly on bookedCallsDashboard.searchBookedCallsDetails:
 * opportunitySearch projection -> by_opportunityId_and_scheduledAt meetings ->
 * post-filter to the dashboard window (scheduledAt, matching the dashboard's
 * dayKey population) -> enrichPhoneSalesRows, so rows are shaped identically
 * to listPhoneSalesMeetings pages. Bounded fan-out, 50 rows max.
 */
export const searchSalesCallsMeetings = query({
  args: {
    searchTerm: v.string(),
    start: v.number(),
    end: v.number(),
    closerId: v.optional(v.id("users")),
  },
  returns: v.array(salesCallsMeetingRowValidator),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    try {
      const { start, end } = validateWindow(args.start, args.end);

      const term = args.searchTerm.trim();
      if (term.length < 2) {
        return [];
      }

      const searchRows = await ctx.db
        .query("opportunitySearch")
        .withSearchIndex("search_opportunities", (q) =>
          q.search("searchText", term).eq("tenantId", tenantId),
        )
        .take(SEARCH_OPPORTUNITY_LIMIT);

      const opportunityIds = uniqueIds(
        searchRows.map((row) => row.opportunityId),
      );

      const meetingsPerOpportunity = await Promise.all(
        opportunityIds.map((opportunityId) =>
          ctx.db
            .query("meetings")
            .withIndex("by_opportunityId_and_scheduledAt", (q) =>
              q.eq("opportunityId", opportunityId),
            )
            .order("desc")
            .take(MEETINGS_PER_OPPORTUNITY_LIMIT),
        ),
      );

      const meetings = meetingsPerOpportunity
        .flat()
        .filter((meeting) => meeting.tenantId === tenantId)
        .filter(
          (meeting) => meeting.scheduledAt >= start && meeting.scheduledAt < end,
        )
        .filter(
          (meeting) =>
            args.closerId === undefined ||
            meeting.assignedCloserId === args.closerId,
        )
        .sort((left, right) => right.scheduledAt - left.scheduledAt)
        .slice(0, SEARCH_RESULT_LIMIT);

      return await enrichPhoneSalesRows(ctx, meetings);
    } catch (error) {
      console.error("[Operations:SalesCalls] searchSalesCallsMeetings failed", {
        tenantId,
        start: args.start,
        end: args.end,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
