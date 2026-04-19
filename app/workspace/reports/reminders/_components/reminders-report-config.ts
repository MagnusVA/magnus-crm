import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";

export type ReminderReportData = FunctionReturnType<
  typeof api.reporting.remindersReporting.getReminderOutcomeFunnel
>;

export type ReminderOutcomeKey =
  ReminderReportData["outcomeBreakdown"][number]["outcome"];

export const OUTCOME_META: Record<
  ReminderOutcomeKey,
  {
    color: string;
    description: string;
    label: string;
  }
> = {
  payment_received: {
    label: "Payment Received",
    description: "Closed with cash collected after reminder outreach.",
    color: "var(--chart-4)",
  },
  lost: {
    label: "Lost",
    description: "Reminder path ended with the opportunity marked lost.",
    color: "var(--chart-5)",
  },
  no_response_rescheduled: {
    label: "No Response → Rescheduled",
    description: "No reply yet, but the chain continued with a fresh reminder.",
    color: "var(--chart-1)",
  },
  no_response_given_up: {
    label: "No Response → Gave Up",
    description: "Reminder sequence ended without additional outreach.",
    color: "var(--chart-2)",
  },
  no_response_close_only: {
    label: "No Response → Close Only",
    description: "Reminder was completed without scheduling the next touch.",
    color: "var(--chart-3)",
  },
};

export function formatCount(value: number): string {
  return value.toLocaleString();
}

export function formatPercent(value: number | null): string {
  if (value === null) {
    return "\u2014";
  }

  return `${(value * 100).toFixed(1)}%`;
}

export function getPendingReminderCount(data: ReminderReportData): number {
  return Math.max(0, data.totalCreated - data.totalCompleted);
}
