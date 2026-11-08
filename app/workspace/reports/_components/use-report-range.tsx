"use client";

import { useMemo } from "react";
import {
  DateRangePicker,
  formatBusinessDateSpan,
  rangePhrase,
  type DashboardRangeInput,
} from "@/app/workspace/_components/date-range-picker";
import type { DashboardRangeValidationOptions } from "@/app/workspace/_components/dashboard-date-utils";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import {
  dashboardRangeFromToday,
  dashboardRangePlan,
  MAX_ANALYTICS_RANGE_DAYS,
  resolveDashboardRange,
} from "@/lib/analyticsRange";
import { businessDateForInstant, businessDayDisclosure } from "@/lib/businessDay";
import { reportDayKeys, reportWindow } from "@/lib/reportDateRange";

// A Reports page's range on the shared picker (DESIGN.md, The One Picker
// Rule), in the tenant's business days like Overview and Operations. The
// picker's preset is resolved into business dates from a ticking clock, so
// the readers' arguments move to the new day when the business day changes,
// and those dates become the timestamps and day keys the readers take.

/** Reports read up to the reporting database's longest range. */
export const REPORT_RANGE_VALIDATION: DashboardRangeValidationOptions = { maxDays: MAX_ANALYTICS_RANGE_DAYS };

const PRESET_WORDS = { today: "Today", this_week: "This week", this_month: "This month" } as const;

export function useReportRange() {
  const { setting, loaded, rebuilding } = useBusinessDay();
  const now = useNow();
  const todayBusinessDate = businessDateForInstant(now, setting);
  const { range, setRange, queryRange, validationMessage } = useDashboardRange({
    validationOptions: REPORT_RANGE_VALIDATION,
  });

  return useMemo(() => {
    const dates = resolveDashboardRange(queryRange, todayBusinessDate);
    const todayDates = resolveDashboardRange(dashboardRangeFromToday(dates, todayBusinessDate), todayBusinessDate);
    /** "This week · Oct 27 – Nov 2", "Today · Nov 5", or a custom range's dates. */
    const wordsFor = (input: DashboardRangeInput) => {
      const resolved = resolveDashboardRange(input, todayBusinessDate);
      const span = formatBusinessDateSpan(resolved.startBusinessDate, resolved.endBusinessDateInclusive, todayBusinessDate);
      return input.kind === "custom" ? span : `${PRESET_WORDS[input.preset]} · ${span}`;
    };
    return {
      setting,
      /** False until the tenant's business day is known, and while it rebuilds: readers skip. */
      ready: loaded && !rebuilding,
      rebuilding,
      todayBusinessDate,
      /** The picker's selection and its setter. */
      range,
      setRange,
      /** The last valid selection, preset kept: key plans and words on it. */
      queryRange,
      validationMessage,
      /** The range as business dates, presets resolved against today. */
      dates,
      /** `{ startDayKey, endDayKeyExclusive }` for meeting-bucket readers. */
      dayKeys: reportDayKeys(dates),
      /** The part from today, for a split's live reader. */
      todayDayKeys: reportDayKeys(todayDates),
      /** `{ startDate, endDate }` in ms for timestamp readers. */
      window: reportWindow(dates, setting),
      todayWindow: reportWindow(todayDates, setting),
      /** Which source answers the range (docs/agents/reporting.md). */
      plan: dashboardRangePlan(queryRange, todayBusinessDate),
      /** "today", "this week", "this month", "in this range". */
      phrase: rangePhrase(queryRange),
      wordsFor,
      words: wordsFor(queryRange),
      /** The band's day line. */
      dayLine: businessDayDisclosure(setting),
    };
  }, [loaded, queryRange, range, rebuilding, setRange, setting, todayBusinessDate, validationMessage]);
}

export type ReportRange = ReturnType<typeof useReportRange>;

/** The shared picker in its board tone, for a report band's action slot. */
export function ReportRangePicker({ range, onChange }: { range: ReportRange; onChange?: (next: DashboardRangeInput) => void }) {
  return (
    <DateRangePicker
      tone="board"
      value={range.range}
      onChange={(next) => {
        range.setRange(next);
        onChange?.(next);
      }}
      validationOptions={REPORT_RANGE_VALIDATION}
      todayBusinessDate={range.todayBusinessDate}
    />
  );
}

/** The picker's reason a custom range can't be shown, under the band. */
export function ReportRangeMessage({ range }: { range: ReportRange }) {
  return range.validationMessage ? <p className="text-[13px] text-danger-ink">{range.validationMessage}</p> : null;
}
