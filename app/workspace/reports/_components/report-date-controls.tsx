"use client";

import { useState } from "react";
import type { DateRange as CalendarDateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { addDays, format, startOfDay, startOfMonth, startOfWeek, subDays, subMonths } from "date-fns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useIsMobile } from "@/hooks/use-mobile";
import { businessDayDisclosure, type BusinessDaySetting } from "@/lib/businessDay";
import { reportDisplayEndDate } from "@/lib/reportDateRange";
import { cn } from "@/lib/utils";
import { BAND_SELECT } from "./report-ui";

// The reports' own date controls, styled as the shared picker's board tone
// (DESIGN.md, The Date Range Picker) so they sit in the report band. Their
// behaviour is unchanged: the same five quick picks and a calendar range,
// with day boundaries from the browser's clock.

type Granularity = "day" | "week" | "month";

interface DateRange {
  startDate: number;
  endDate: number;
}

interface ReportDateControlsProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  granularity?: Granularity;
  onGranularityChange?: (g: Granularity) => void;
  showGranularity?: boolean;
}

function getStartOfDayTimestamp(date: Date): number {
  return startOfDay(date).getTime();
}

function getExclusiveUpperTimestamp(date: Date): number {
  return startOfDay(addDays(date, 1)).getTime();
}

type QuickPick = { key: string; label: string; phrase: string; getRange: () => DateRange };

const QUICK_PICKS: readonly QuickPick[] = [
  {
    key: "today",
    label: "Today",
    phrase: "today",
    getRange: () => {
      const now = new Date();
      return { startDate: getStartOfDayTimestamp(now), endDate: getExclusiveUpperTimestamp(now) };
    },
  },
  {
    key: "this_week",
    label: "This week",
    phrase: "this week",
    getRange: () => {
      const now = new Date();
      return { startDate: startOfWeek(now, { weekStartsOn: 1 }).getTime(), endDate: getExclusiveUpperTimestamp(now) };
    },
  },
  {
    key: "this_month",
    label: "This month",
    phrase: "this month",
    getRange: () => {
      const now = new Date();
      return { startDate: startOfMonth(now).getTime(), endDate: getExclusiveUpperTimestamp(now) };
    },
  },
  {
    key: "last_month",
    label: "Last month",
    phrase: "last month",
    getRange: () => {
      const now = new Date();
      return { startDate: startOfMonth(subMonths(now, 1)).getTime(), endDate: startOfMonth(now).getTime() };
    },
  },
  {
    key: "last_90_days",
    label: "Last 90 days",
    phrase: "in the last 90 days",
    getRange: () => {
      const now = new Date();
      return { startDate: subDays(startOfDay(now), 89).getTime(), endDate: getExclusiveUpperTimestamp(now) };
    },
  },
];

/** The quick pick a range matches, if any. */
function matchingPick(value: DateRange) {
  return QUICK_PICKS.find((pick) => {
    const range = pick.getRange();
    return range.startDate === value.startDate && range.endDate === value.endDate;
  });
}

/** "Oct 3 – Oct 17", with years only outside this year. */
function formatSpan(value: DateRange) {
  const end = reportDisplayEndDate(value.endDate);
  const year = new Date().getFullYear();
  const label = (date: Date) => format(date, date.getFullYear() === year ? "MMM d" : "MMM d, yyyy");
  const start = new Date(value.startDate);
  return format(start, "yyyy-MM-dd") === format(end, "yyyy-MM-dd") ? label(start) : `${label(start)} – ${label(end)}`;
}

/** The band's range words: "This week · Oct 27 – Nov 2", or a custom range's dates. */
export function reportRangeWords(value: DateRange) {
  const pick = matchingPick(value);
  return pick ? `${pick.label} · ${formatSpan(value)}` : formatSpan(value);
}

/** How empty lines name the range: "today", "this week", "last month", "in this range". */
export function reportRangePhrase(value: DateRange) {
  return matchingPick(value)?.phrase ?? "in this range";
}

/** The band's line on how days are counted. */
export function reportDayLine(dayDefinition: "browser" | "tenant", setting: BusinessDaySetting) {
  return dayDefinition === "browser" ? "Days follow your browser's time zone" : businessDayDisclosure(setting);
}

const GRANULARITY_LABEL: Record<Granularity, string> = { day: "By day", week: "By week", month: "By month" };

export function ReportDateControls({
  value,
  onChange,
  granularity,
  onGranularityChange,
  showGranularity = false,
}: ReportDateControlsProps) {
  const isMobile = useIsMobile();
  const displayEndDate = reportDisplayEndDate(value.endDate);
  const [isOpen, setIsOpen] = useState(false);
  // Pending range for the calendar while the popover is open: a first click
  // never applies a range (react-day-picker's controlled range mode keeps the
  // old `to`), and nothing is applied until "Show this range".
  const [pendingRange, setPendingRange] = useState<CalendarDateRange | undefined>(undefined);
  const canApply = Boolean(pendingRange?.from && pendingRange?.to);
  const pick = matchingPick(value);

  // Seed the pending range from the applied one each time the popover opens.
  const handleOpenChange = (next: boolean) => {
    if (next) setPendingRange({ from: new Date(value.startDate), to: displayEndDate });
    setIsOpen(next);
  };

  const handleApply = () => {
    if (pendingRange?.from && pendingRange?.to) {
      onChange({
        startDate: getStartOfDayTimestamp(pendingRange.from),
        endDate: getExclusiveUpperTimestamp(pendingRange.to),
      });
    }
    setIsOpen(false);
  };

  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
      <ToggleGroup
        type="single"
        size="sm"
        value={pick?.key ?? ""}
        onValueChange={(next) => {
          const chosen = QUICK_PICKS.find((entry) => entry.key === next);
          if (chosen) onChange(chosen.getRange());
        }}
        aria-label="Date range"
        className="h-[34px] max-w-full overflow-x-auto rounded-[7px] border border-board-foreground/15 bg-board-raised p-0.5 [scrollbar-width:none]"
      >
        {QUICK_PICKS.map((entry) => (
          <ToggleGroupItem
            key={entry.key}
            value={entry.key}
            className="h-full shrink-0 rounded-[5px]! px-3 font-condensed text-[13px] font-semibold tracking-[0.1em] whitespace-nowrap text-board-muted uppercase hover:bg-board-foreground/10 hover:text-board-foreground data-[state=on]:bg-board-foreground data-[state=on]:text-board"
          >
            {entry.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            aria-pressed={pick === undefined}
            aria-label={pick === undefined ? `Custom range, ${formatSpan(value)}` : "Custom range"}
            className="h-[34px] rounded-[7px] border-board-foreground/15 bg-board-raised px-3 text-[13px] text-board-foreground hover:bg-board-foreground/10 hover:text-board-foreground aria-pressed:border-board-foreground aria-pressed:bg-board-foreground aria-pressed:text-board dark:border-board-foreground/15 dark:bg-board-raised dark:hover:bg-board-foreground/10 dark:aria-pressed:bg-board-foreground dark:aria-pressed:hover:bg-board-foreground/90"
          >
            <CalendarIcon data-icon="inline-start" aria-hidden="true" />
            <span
              className={cn(
                "hidden @xl:inline",
                pick === undefined && "font-condensed text-[14px] font-semibold tracking-[0.02em]",
              )}
            >
              {pick === undefined ? formatSpan(value) : "Custom range"}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" collisionPadding={16} className="w-[calc(100vw-2rem)] max-w-fit p-2">
          <Calendar
            mode="range"
            selected={pendingRange}
            onSelect={setPendingRange}
            numberOfMonths={isMobile ? 1 : 2}
            showOutsideDays={isMobile}
            className="[&_[data-range-end=true]]:bg-foreground! [&_[data-range-end=true]]:text-background! [&_[data-range-start=true]]:bg-foreground! [&_[data-range-start=true]]:text-background!"
          />
          <div className="flex items-center justify-between gap-3 border-t px-2 pt-2">
            <p className={cn("min-w-0 text-[13px]", canApply ? "text-foreground" : "text-muted-foreground")}>
              {canApply && pendingRange?.from && pendingRange.to
                ? formatSpan({
                    startDate: getStartOfDayTimestamp(pendingRange.from),
                    endDate: getExclusiveUpperTimestamp(pendingRange.to),
                  })
                : "Pick a first and a last day."}
            </p>
            <Button size="sm" onClick={handleApply} disabled={!canApply}>
              Show this range
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {showGranularity && onGranularityChange ? (
        <Select value={granularity} onValueChange={(next) => onGranularityChange(next as Granularity)}>
          <SelectTrigger aria-label="Group the trend" className={cn(BAND_SELECT, "w-[112px]")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(GRANULARITY_LABEL) as Granularity[]).map((option) => (
              <SelectItem key={option} value={option}>
                {GRANULARITY_LABEL[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}

export type { DateRange, Granularity, ReportDateControlsProps };
