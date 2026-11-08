import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";

export type ReminderReportData = FunctionReturnType<
  typeof api.reporting.remindersReporting.getReminderOutcomeFunnel
>;

export const REMINDERS_BAND_TITLE = "Reminder outcomes";

/** Closers beside the chains from @5xl, each at its own height. */
export const REMINDERS_PAIR = "grid items-start gap-3.5 short:gap-3 @5xl:grid-cols-[1.35fr_1fr]";

export type ReminderOutcomeKey =
  ReminderReportData["outcomeBreakdown"][number]["outcome"];

/** Each outcome's name, and what it means for its `HelpTip`. */
export const OUTCOME_META: Record<ReminderOutcomeKey, { label: string; description: string }> = {
  payment_received: {
    label: "Payment received",
    description: "Closed with cash collected after the reminder.",
  },
  lost: {
    label: "Lost",
    description: "The deal was marked lost.",
  },
  no_response_rescheduled: {
    label: "No reply, rescheduled",
    description: "No reply yet; the closer set a fresh reminder.",
  },
  no_response_given_up: {
    label: "No reply, gave up",
    description: "No reply, and no more outreach.",
  },
  no_response_close_only: {
    label: "No reply, closed",
    description: "Completed without scheduling the next touch.",
  },
};

export function formatCount(value: number): string {
  return value.toLocaleString();
}

export function formatPercent(value: number | null): string {
  if (value === null) {
    return "—";
  }

  return `${(value * 100).toFixed(1)}%`;
}

export function getPendingReminderCount(data: ReminderReportData): number {
  return Math.max(0, data.totalCreated - data.totalCompleted);
}
