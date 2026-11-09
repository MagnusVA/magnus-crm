"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  DateRangePicker,
  formatBusinessDateSpan,
  RANGE_PRESET_LABELS,
  rangePhrase,
  rangePresetOptions,
  type DashboardRangeInput,
} from "@/app/workspace/_components/date-range-picker";
import type { DashboardRangeValidationOptions } from "@/app/workspace/_components/dashboard-date-utils";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import {
  dashboardLiveRange,
  dashboardRangePlan,
  MAX_ANALYTICS_RANGE_DAYS,
  REPORT_RANGE_PRESETS,
  resolveDashboardRange,
  settledThroughDate,
  type ReportRangePreset,
} from "@/lib/analyticsRange";
import { businessDateForInstant, businessDayDisclosure, businessDayStart } from "@/lib/businessDay";
import { reportDayKeys, reportWindow } from "@/lib/reportDateRange";

// A Reports page's range on the shared picker (DESIGN.md, The One Picker
// Rule), in the tenant's business days like Overview and Operations. The
// picker's preset is resolved into business dates from a ticking clock, so
// the readers' arguments move to the new day when the business day changes,
// and those dates become the timestamps and day keys the readers take.

/** Reports read up to the reporting database's longest range. */
export const REPORT_RANGE_VALIDATION: DashboardRangeValidationOptions = { maxDays: MAX_ANALYTICS_RANGE_DAYS };

/** A Reports range: the dashboards' presets and the Reports-only ones. */
export type ReportRangeInput = DashboardRangeInput<ReportRangePreset>;

// The toggle holds the presets people pick most; More holds the rest
// (reports-overhaul §13). Overview and Operations keep their three.
const REPORT_PICKER_PRESETS = rangePresetOptions<ReportRangePreset>(
  ["today", "this_week", "this_month", "last_month"],
  ["yesterday", "last_week", "last_90_days", "year_to_date"],
);

export function useReportRange() {
  const { setting, loaded, rebuilding } = useBusinessDay();
  const now = useNow();
  const todayBusinessDate = businessDateForInstant(now, setting);
  // The range lives in the URL, so a report link, a bookmark and an old
  // report's redirect (?range=this_month) open on the same range.
  const { range, setRange, queryRange, validationMessage } = useDashboardRange<ReportRangePreset>({
    urlSync: true,
    presets: REPORT_RANGE_PRESETS,
    validationOptions: REPORT_RANGE_VALIDATION,
  });
  // Until a sync whose watermark is past the start of today lands, yesterday
  // reads live too (reports-decisions D1). While the watermark loads, plan
  // through yesterday as before.
  const sync = useQuery(api.analytics.sync.getSyncWatermark, {});
  const settledThrough =
    sync === undefined
      ? undefined
      : settledThroughDate(todayBusinessDate, sync.watermark, businessDayStart(todayBusinessDate, setting));

  return useMemo(() => {
    const dates = resolveDashboardRange(queryRange, todayBusinessDate);
    const plan = dashboardRangePlan(queryRange, todayBusinessDate, settledThrough);
    const liveStartDate = plan.kind === "split" ? plan.liveStartDate : todayBusinessDate;
    const todayDates = resolveDashboardRange(dashboardLiveRange(dates, todayBusinessDate, liveStartDate), todayBusinessDate);
    /** "This week · Oct 27 – Nov 2", "Today · Nov 5", or a custom range's dates. */
    const wordsFor = (input: ReportRangeInput) => {
      const resolved = resolveDashboardRange(input, todayBusinessDate);
      const span = formatBusinessDateSpan(resolved.startBusinessDate, resolved.endBusinessDateInclusive, todayBusinessDate);
      return input.kind === "custom" ? span : `${RANGE_PRESET_LABELS[input.preset]} · ${span}`;
    };
    return {
      setting,
      /** True once the tenant's business day is known: timestamp readers wait for this. */
      loaded,
      /** Also false while meeting buckets rebuild: day-key bucket readers wait for this. */
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
      /** The part a split's live reader answers: from today, or from yesterday overnight. */
      todayDayKeys: reportDayKeys(todayDates),
      /** `{ startDate, endDate }` in ms for timestamp readers. */
      window: reportWindow(dates, setting),
      todayWindow: reportWindow(todayDates, setting),
      /** Which source answers the range (docs/agents/reporting.md). */
      plan,
      /** "today", "last week", "in the last 90 days", "in this range". */
      phrase: rangePhrase(queryRange),
      wordsFor,
      words: wordsFor(queryRange),
      /** The band's day line. */
      dayLine: businessDayDisclosure(setting),
    };
  }, [loaded, queryRange, range, rebuilding, setRange, setting, settledThrough, todayBusinessDate, validationMessage]);
}

export type ReportRange = ReturnType<typeof useReportRange>;

/** The shared picker in its board tone, for a report band's action slot. */
export function ReportRangePicker({ range, onChange }: { range: ReportRange; onChange?: (next: ReportRangeInput) => void }) {
  return (
    <DateRangePicker<ReportRangePreset>
      tone="board"
      presets={REPORT_PICKER_PRESETS.presets}
      morePresets={REPORT_PICKER_PRESETS.morePresets}
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
