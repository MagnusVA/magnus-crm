import type { getReminderOutcomeFunnel } from "../../reporting/remindersReporting";
import type { ReaderOutput } from "../definition";
import { addCounts, mergeRows, rate } from "./helpers";

type ReminderOutcomeFunnel = ReaderOutput<typeof getReminderOutcomeFunnel>;

export function mergeReminderOutcomeFunnel(
  history: ReminderOutcomeFunnel,
  today: ReminderOutcomeFunnel,
): ReminderOutcomeFunnel {
  const totalCreated = history.totalCreated + today.totalCreated;
  const totalCompleted = history.totalCompleted + today.totalCompleted;
  const outcomeMix = addCounts(history.outcomeMix, today.outcomeMix);
  return {
    totalCreated,
    totalCompleted,
    completionRate: rate(totalCompleted, totalCreated),
    outcomeMix,
    outcomeBreakdown: today.outcomeBreakdown.map((row) => ({
      ...row,
      count: outcomeMix[row.outcome],
      percentOfCompleted: rate(outcomeMix[row.outcome], totalCompleted),
    })),
    completedWithoutOutcomeCount:
      history.completedWithoutOutcomeCount + today.completedWithoutOutcomeCount,
    perCloser: mergeRows(
      history.perCloser,
      today.perCloser,
      (row) => row.closerId,
      (past, current) => {
        const created = past.created + current.created;
        const completed = past.completed + current.completed;
        return {
          ...current,
          created,
          completed,
          completionRate: rate(completed, created),
          paymentReceivedCount: past.paymentReceivedCount + current.paymentReceivedCount,
          completedWithoutOutcomeCount:
            past.completedWithoutOutcomeCount + current.completedWithoutOutcomeCount,
          outcomeMix: addCounts(past.outcomeMix, current.outcomeMix),
        };
      },
    ).sort(
      (left, right) =>
        right.paymentReceivedCount - left.paymentReceivedCount ||
        (right.completionRate ?? -1) - (left.completionRate ?? -1) ||
        right.created - left.created ||
        left.closerName.localeCompare(right.closerName),
    ),
    // The answers omit deal IDs. A chain spanning both windows is counted
    // separately in each window's bucket and distinct-deal count.
    chainLengthHistogram: mergeRows(
      history.chainLengthHistogram,
      today.chainLengthHistogram,
      (row) => row.bucket,
      (past, current) => ({ ...current, count: past.count + current.count }),
    ),
    opportunitiesWithReminderChains:
      history.opportunitiesWithReminderChains + today.opportunitiesWithReminderChains,
    reminderDrivenFinalRevenueMinor:
      history.reminderDrivenFinalRevenueMinor + today.reminderDrivenFinalRevenueMinor,
    reminderDrivenDepositRevenueMinor:
      history.reminderDrivenDepositRevenueMinor + today.reminderDrivenDepositRevenueMinor,
    reminderDrivenRevenueMinor:
      history.reminderDrivenRevenueMinor + today.reminderDrivenRevenueMinor,
    reminderDrivenPaymentCount:
      history.reminderDrivenPaymentCount + today.reminderDrivenPaymentCount,
    isReminderRevenueTruncated:
      history.isReminderRevenueTruncated || today.isReminderRevenueTruncated,
    isTruncated: history.isTruncated || today.isTruncated,
  };
}
