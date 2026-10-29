"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
  BUSINESS_DAY_REBUILD_MESSAGE,
  businessDayHourLabel,
  type BusinessDaySetting,
} from "@/lib/businessDay";
import { shiftMonth, type MonthKey, type PipelineMonth } from "@/lib/closer-pipeline";
import { Button } from "@/components/ui/button";
import { formatRangeLabel } from "@/app/workspace/closer/_components/today-time";

// How far back the switcher goes: three years of months.
const MONTHS_BACK = 36;

/**
 * "My Pipeline", the business month it reads with how its days are counted,
 * and the month switcher: this month and the months before it.
 */
export function PipelineHeader({
  month,
  currentKey,
  setting,
  rebuilding,
  onMonthChange,
}: {
  month: PipelineMonth;
  currentKey: MonthKey;
  setting: BusinessDaySetting;
  rebuilding: boolean;
  onMonthChange: (key: MonthKey) => void;
}) {
  const hour = businessDayHourLabel(setting);
  const earliest = shiftMonth(currentKey, -MONTHS_BACK);
  const span = month.isCurrent
    ? `Day ${month.day} of ${month.days}`
    : formatRangeLabel(month.startDate, month.endDate, setting);

  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-[1.1] font-semibold tracking-[-0.01em]">My Pipeline</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {span} · Days run {hour}–{hour}, {setting.timeZone}
        </p>
        {rebuilding ? (
          <p role="status" className="mt-1 text-[13px] text-muted-foreground">
            {BUSINESS_DAY_REBUILD_MESSAGE}
          </p>
        ) : null}
      </div>

      <nav aria-label="Month" className="flex items-center gap-1">
        {!month.isCurrent ? (
          <Button
            variant="ghost"
            size="sm"
            className="mr-1 text-[13px] text-muted-foreground"
            onClick={() => onMonthChange(currentKey)}
          >
            This month
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous month"
          disabled={month.key <= earliest}
          onClick={() => onMonthChange(shiftMonth(month.key, -1))}
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <p
          aria-live="polite"
          className="min-w-[8.5rem] text-center font-condensed text-[19px] leading-none font-semibold tracking-[0.02em] tabular-nums"
        >
          {month.name}
        </p>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next month"
          disabled={month.isCurrent}
          onClick={() => onMonthChange(shiftMonth(month.key, 1))}
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </nav>
    </header>
  );
}
