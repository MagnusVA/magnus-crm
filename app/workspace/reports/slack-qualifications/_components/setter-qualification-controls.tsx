"use client";

import { useState } from "react";
import type { DateRange as CalendarDateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useIsMobile } from "@/hooks/use-mobile";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { BAND_SELECT } from "../../_components/report-ui";
import {
  addBusinessDays,
  businessDateToCalendarDate,
  calendarDateToBusinessDate,
  getCurrentHondurasBusinessDate,
  getInclusiveEndBusinessDate,
  getQuickRange,
  type SlackQualificationFilters,
  type SlackQualificationGranularity,
} from "./business-date-utils";

// The report's own business-date controls, in the shared picker's board
// tone (DESIGN.md, The Date Range Picker) so they sit in the report band.
// Their behaviour is unchanged: the same five quick picks, a calendar range
// applied as business dates, the granularity and the setter.

type SetterOption = {
  slackUserId: string;
  displayName: string;
  isDeleted: boolean;
};

type QuickKey = Parameters<typeof getQuickRange>[0];

const QUICK_PICKS: ReadonlyArray<{ key: QuickKey; label: string; phrase: string }> = [
  { key: "today", label: "Today", phrase: "today" },
  { key: "yesterday", label: "Yesterday", phrase: "yesterday" },
  { key: "this_week", label: "This week", phrase: "this week" },
  { key: "this_month", label: "This month", phrase: "this month" },
  { key: "last_30", label: "Last 30 days", phrase: "in the last 30 days" },
];

const GRANULARITY_LABEL: Record<SlackQualificationGranularity, string> = {
  day: "By day",
  week: "By week",
  month: "By month",
};

const BOARD_BUTTON =
  "h-[34px] rounded-[7px] border-board-foreground/15 bg-board-raised px-3 text-[13px] text-board-foreground hover:bg-board-foreground/10 hover:text-board-foreground aria-pressed:border-board-foreground aria-pressed:bg-board-foreground aria-pressed:text-board dark:border-board-foreground/15 dark:bg-board-raised dark:hover:bg-board-foreground/10 dark:aria-pressed:bg-board-foreground dark:aria-pressed:hover:bg-board-foreground/90";

/** The quick pick the filters' dates match, if any. */
function matchingPick(value: SlackQualificationFilters, setting: BusinessDaySetting) {
  return QUICK_PICKS.find((pick) => {
    const range = getQuickRange(pick.key, setting);
    return range.startBusinessDate === value.startBusinessDate && range.endBusinessDateExclusive === value.endBusinessDateExclusive;
  });
}

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthDayYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Oct 3 – Oct 17" from business dates, with years only outside this year. */
function formatSpan(start: string, endInclusive: string, setting: BusinessDaySetting) {
  const year = getCurrentHondurasBusinessDate(Date.now(), setting).slice(0, 4);
  const format = (dateKey: string) =>
    (dateKey.slice(0, 4) === year ? monthDay : monthDayYear).format(new Date(`${dateKey}T00:00:00Z`));
  return start === endInclusive ? format(start) : `${format(start)} – ${format(endInclusive)}`;
}

/** The band's range words: "This week · Nov 2 – Nov 5", or a custom range's dates. */
export function slackRangeWords(value: SlackQualificationFilters, setting: BusinessDaySetting) {
  const span = formatSpan(value.startBusinessDate, getInclusiveEndBusinessDate(value.endBusinessDateExclusive), setting);
  const pick = matchingPick(value, setting);
  return pick ? `${pick.label} · ${span}` : span;
}

/** How empty lines name the range: "today", "this week", "in this range". */
export function slackRangePhrase(value: SlackQualificationFilters, setting: BusinessDaySetting) {
  return matchingPick(value, setting)?.phrase ?? "in this range";
}

/** The band's action slot: quick picks, the calendar range and the granularity. */
export function SetterQualificationDateControls({
  value,
  onChange,
}: {
  value: SlackQualificationFilters;
  onChange: (value: SlackQualificationFilters) => void;
}) {
  const { setting } = useBusinessDay();
  const isMobile = useIsMobile();
  const [isOpen, setIsOpen] = useState(false);
  const [pendingRange, setPendingRange] = useState<CalendarDateRange | undefined>(undefined);

  const inclusiveEnd = getInclusiveEndBusinessDate(value.endBusinessDateExclusive);
  const canApply = Boolean(pendingRange?.from && pendingRange?.to);
  const pick = matchingPick(value, setting);
  const span = formatSpan(value.startBusinessDate, inclusiveEnd, setting);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setPendingRange({
        from: businessDateToCalendarDate(value.startBusinessDate),
        to: businessDateToCalendarDate(inclusiveEnd),
      });
    }
    setIsOpen(next);
  };

  const applyPendingRange = () => {
    if (!pendingRange?.from || !pendingRange.to) {
      return;
    }

    const startBusinessDate = calendarDateToBusinessDate(pendingRange.from);
    const inclusiveEndBusinessDate = calendarDateToBusinessDate(pendingRange.to);
    onChange({
      ...value,
      startBusinessDate,
      endBusinessDateExclusive: addBusinessDays(inclusiveEndBusinessDate, 1),
    });
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
          if (chosen) onChange({ ...value, ...getQuickRange(chosen.key, setting) });
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
            type="button"
            variant="outline"
            aria-pressed={pick === undefined}
            aria-label={pick === undefined ? `Custom range, ${span}` : "Custom range"}
            className={BOARD_BUTTON}
          >
            <CalendarIcon data-icon="inline-start" aria-hidden="true" />
            <span
              className={cn(
                "hidden @xl:inline",
                pick === undefined && "font-condensed text-[14px] font-semibold tracking-[0.02em]",
              )}
            >
              {pick === undefined ? span : "Custom range"}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" collisionPadding={16} className="w-[calc(100vw-2rem)] max-w-fit p-2">
          <Calendar
            mode="range"
            selected={pendingRange}
            onSelect={(range) => setPendingRange(range)}
            numberOfMonths={isMobile ? 1 : 2}
            showOutsideDays={isMobile}
            className="[&_[data-range-end=true]]:bg-foreground! [&_[data-range-end=true]]:text-background! [&_[data-range-start=true]]:bg-foreground! [&_[data-range-start=true]]:text-background!"
          />
          <div className="flex items-center justify-between gap-3 border-t px-2 pt-2">
            <p className={cn("min-w-0 text-[13px]", canApply ? "text-foreground" : "text-muted-foreground")}>
              {canApply && pendingRange?.from && pendingRange.to
                ? formatSpan(calendarDateToBusinessDate(pendingRange.from), calendarDateToBusinessDate(pendingRange.to), setting)
                : "Pick a first and a last day."}
            </p>
            <Button type="button" size="sm" onClick={applyPendingRange} disabled={!canApply}>
              Show this range
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Select
        value={value.granularity}
        onValueChange={(granularity) =>
          onChange({
            ...value,
            granularity: granularity as SlackQualificationGranularity,
          })
        }
      >
        <SelectTrigger aria-label="Group the trend" className={cn(BAND_SELECT, "w-[112px]")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {(Object.keys(GRANULARITY_LABEL) as SlackQualificationGranularity[]).map((option) => (
              <SelectItem key={option} value={option}>
                {GRANULARITY_LABEL[option]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

/** The band's filter: one setter, or all of them. */
export function SetterFilter({
  setters,
  value,
  onChange,
}: {
  setters: SetterOption[];
  value: SlackQualificationFilters;
  onChange: (value: SlackQualificationFilters) => void;
}) {
  return (
    <Select
      value={value.slackUserId ?? "all"}
      onValueChange={(slackUserId) =>
        onChange({
          ...value,
          slackUserId: slackUserId === "all" ? null : slackUserId,
        })
      }
    >
      <SelectTrigger aria-label="Setter" className={cn(BAND_SELECT, "w-[224px] max-w-full")}>
        <SelectValue placeholder="All setters" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="all">All setters</SelectItem>
          {setters.map((setter) => (
            <SelectItem key={setter.slackUserId} value={setter.slackUserId}>
              {setter.displayName}
              {setter.isDeleted ? " (deactivated)" : ""}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
