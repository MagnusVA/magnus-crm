"use client";

import { useCallback, useMemo } from "react";
import { startOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from "date-fns";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type TimePeriod = "today" | "this_week" | "this_month";

export interface DateRange {
  periodStart: number;
  periodEnd: number;
}

const PERIOD_OPTIONS = [
  { value: "today" as const, label: "Day" },
  { value: "this_week" as const, label: "Week" },
  { value: "this_month" as const, label: "Month" },
] as const;

/** Human-readable label for the selected period (used in stat subtexts). */
export function getPeriodLabel(period: TimePeriod): string {
  switch (period) {
    case "today":
      return "Today";
    case "this_week":
      return "This week";
    case "this_month":
      return "This month";
  }
}

/** Compute [periodStart, periodEnd) window from a period selection. */
export function getDateRange(period: TimePeriod): DateRange {
  const now = new Date();
  switch (period) {
    case "today": {
      const start = startOfDay(now);
      return {
        periodStart: start.getTime(),
        periodEnd: start.getTime() + 24 * 60 * 60 * 1000,
      };
    }
    case "this_week": {
      const start = startOfWeek(now, { weekStartsOn: 1 });
      const end = endOfWeek(now, { weekStartsOn: 1 });
      return {
        periodStart: start.getTime(),
        periodEnd: end.getTime() + 1,
      };
    }
    case "this_month": {
      const start = startOfMonth(now);
      const end = endOfMonth(now);
      return {
        periodStart: start.getTime(),
        periodEnd: end.getTime() + 1,
      };
    }
  }
}

interface TimePeriodFilterProps {
  value: TimePeriod;
  onValueChange: (period: TimePeriod) => void;
}

export function TimePeriodFilter({ value, onValueChange }: TimePeriodFilterProps) {
  const handleChange = useCallback(
    (next: string) => {
      // ToggleGroup fires "" when deselecting — keep current value
      if (next) {
        onValueChange(next as TimePeriod);
      }
    },
    [onValueChange],
  );

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={handleChange}
      variant="outline"
      size="sm"
      aria-label="Filter stats by time period"
    >
      {PERIOD_OPTIONS.map((opt) => (
        <ToggleGroupItem key={opt.value} value={opt.value} aria-label={opt.label}>
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Hook that derives a stable DateRange from the selected period. */
export function useDateRange(period: TimePeriod): DateRange {
  return useMemo(() => getDateRange(period), [period]);
}
