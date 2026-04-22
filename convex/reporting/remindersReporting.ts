import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { paymentTypeValidator, resolvePaymentType } from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getUserDisplayName,
  splitPaymentsForRevenueReporting,
} from "./lib/helpers";

const MAX_FOLLOWUP_SCAN_ROWS = 2000;
const MAX_REMINDER_REVENUE_SCAN_ROWS = 2000;
const REMINDER_PAYMENT_ORIGINS = [
  "closer_reminder",
  "admin_reminder",
] as const;

const COMPLETION_OUTCOMES = [
  "payment_received",
  "lost",
  "no_response_rescheduled",
  "no_response_given_up",
  "no_response_close_only",
] as const satisfies ReadonlyArray<
  NonNullable<Doc<"followUps">["completionOutcome"]>
>;

const CHAIN_BUCKETS = ["1", "2", "3", "4", "5+"] as const;

type CompletionOutcome = (typeof COMPLETION_OUTCOMES)[number];
type ChainBucket = (typeof CHAIN_BUCKETS)[number];
type OutcomeMix = Record<CompletionOutcome, number>;
type PerCloserBucket = OutcomeMix & {
  completedWithoutOutcomeCount: number;
  created: number;
  completed: number;
};

function emptyOutcomeMix(): OutcomeMix {
  return {
    payment_received: 0,
    lost: 0,
    no_response_rescheduled: 0,
    no_response_given_up: 0,
    no_response_close_only: 0,
  };
}

function emptyPerCloserBucket(): PerCloserBucket {
  return {
    created: 0,
    completed: 0,
    completedWithoutOutcomeCount: 0,
    ...emptyOutcomeMix(),
  };
}

function toRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function bucketChainLength(length: number): ChainBucket {
  if (length <= 1) {
    return "1";
  }
  if (length === 2) {
    return "2";
  }
  if (length === 3) {
    return "3";
  }
  if (length === 4) {
    return "4";
  }
  return "5+";
}

export const getReminderOutcomeFunnel = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    programId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(paymentTypeValidator),
  },
  handler: async (ctx, { startDate, endDate, programId, paymentType }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    assertValidDateRange(startDate, endDate);

    const rows = await ctx.db
      .query("followUps")
      .withIndex("by_tenantId_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).gte("createdAt", startDate).lt("createdAt", endDate),
      )
      .take(MAX_FOLLOWUP_SCAN_ROWS);

    const manualReminders = rows.filter(
      (row): row is Doc<"followUps"> & { type: "manual_reminder" } =>
        row.type === "manual_reminder",
    );
    const reminderRevenueRows: Array<Doc<"paymentRecords">> = [];
    let isReminderRevenueTruncated = false;

    outer: for (const origin of REMINDER_PAYMENT_ORIGINS) {
      const payments = ctx.db
        .query("paymentRecords")
        .withIndex("by_tenantId_and_origin_and_recordedAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("origin", origin)
            .gte("recordedAt", startDate)
            .lt("recordedAt", endDate),
        );

      for await (const payment of payments) {
        if (payment.status === "disputed") {
          continue;
        }

        reminderRevenueRows.push(payment);
        if (reminderRevenueRows.length > MAX_REMINDER_REVENUE_SCAN_ROWS) {
          isReminderRevenueTruncated = true;
          break outer;
        }
      }
    }

    const reminderRevenue = reminderRevenueRows.slice(
      0,
      MAX_REMINDER_REVENUE_SCAN_ROWS,
    );
    const filteredReminderRevenue = reminderRevenue.filter(
      (payment) =>
        (!programId || payment.programId === programId) &&
        (!paymentType ||
          resolvePaymentType(payment.paymentType) === paymentType),
    );
    const reminderRevenueSplit = splitPaymentsForRevenueReporting(
      filteredReminderRevenue,
    );

    if (reminderRevenueSplit.nonCommissionable.allPayments.length > 0) {
      console.warn(
        "[Reporting:Reminders] Non-commissionable reminder payments detected",
        {
          tenantId,
          count: reminderRevenueSplit.nonCommissionable.allPayments.length,
        },
      );
    }

    const reminderDrivenFinalRevenueMinor =
      reminderRevenueSplit.commissionable.finalRevenueMinor;
    const reminderDrivenDepositRevenueMinor =
      reminderRevenueSplit.commissionable.depositRevenueMinor;
    const reminderDrivenRevenueMinor =
      reminderDrivenFinalRevenueMinor + reminderDrivenDepositRevenueMinor;

    const outcomeMix = emptyOutcomeMix();
    const perCloser = new Map<Id<"users">, PerCloserBucket>();
    const chainByOpportunity = new Map<Id<"opportunities">, number>();
    let totalCompleted = 0;
    let completedWithoutOutcomeCount = 0;

    for (const reminder of manualReminders) {
      const closerBucket =
        perCloser.get(reminder.closerId) ?? emptyPerCloserBucket();
      closerBucket.created += 1;

      if (reminder.status === "completed") {
        totalCompleted += 1;
        closerBucket.completed += 1;

        if (reminder.completionOutcome) {
          outcomeMix[reminder.completionOutcome] += 1;
          closerBucket[reminder.completionOutcome] += 1;
        } else {
          completedWithoutOutcomeCount += 1;
          closerBucket.completedWithoutOutcomeCount += 1;
        }
      }

      perCloser.set(reminder.closerId, closerBucket);
      chainByOpportunity.set(
        reminder.opportunityId,
        (chainByOpportunity.get(reminder.opportunityId) ?? 0) + 1,
      );
    }

    const closerIds = [...perCloser.keys()];
    const closerDocs = await Promise.all(
      closerIds.map(async (closerId) => [closerId, await ctx.db.get(closerId)] as const),
    );
    const closerById = new Map(closerDocs);

    const perCloserRows = [...perCloser.entries()]
      .map(([closerId, bucket]) => ({
        closerId,
        closerName: getUserDisplayName(closerById.get(closerId) ?? null),
        created: bucket.created,
        completed: bucket.completed,
        completionRate: toRate(bucket.completed, bucket.created),
        paymentReceivedCount: bucket.payment_received,
        completedWithoutOutcomeCount: bucket.completedWithoutOutcomeCount,
        outcomeMix: {
          payment_received: bucket.payment_received,
          lost: bucket.lost,
          no_response_rescheduled: bucket.no_response_rescheduled,
          no_response_given_up: bucket.no_response_given_up,
          no_response_close_only: bucket.no_response_close_only,
        },
      }))
      .sort(
        (left, right) =>
          right.paymentReceivedCount - left.paymentReceivedCount ||
          (right.completionRate ?? -1) - (left.completionRate ?? -1) ||
          right.created - left.created ||
          left.closerName.localeCompare(right.closerName),
      );

    const chainLengthHistogramCounts = Object.fromEntries(
      CHAIN_BUCKETS.map((bucket) => [bucket, 0]),
    ) as Record<ChainBucket, number>;
    for (const chainLength of chainByOpportunity.values()) {
      const bucket = bucketChainLength(chainLength);
      chainLengthHistogramCounts[bucket] += 1;
    }

    return {
      totalCreated: manualReminders.length,
      totalCompleted,
      completionRate: toRate(totalCompleted, manualReminders.length),
      outcomeMix,
      outcomeBreakdown: COMPLETION_OUTCOMES.map((outcome) => ({
        outcome,
        count: outcomeMix[outcome],
        percentOfCompleted: toRate(outcomeMix[outcome], totalCompleted),
      })),
      completedWithoutOutcomeCount,
      perCloser: perCloserRows,
      chainLengthHistogram: CHAIN_BUCKETS.map((bucket) => ({
        bucket,
        count: chainLengthHistogramCounts[bucket],
      })),
      opportunitiesWithReminderChains: chainByOpportunity.size,
      reminderDrivenFinalRevenueMinor,
      reminderDrivenDepositRevenueMinor,
      reminderDrivenRevenueMinor,
      reminderDrivenPaymentCount: filteredReminderRevenue.length,
      isReminderRevenueTruncated,
      isTruncated: rows.length >= MAX_FOLLOWUP_SCAN_ROWS,
    };
  },
});
