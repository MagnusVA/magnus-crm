"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { DateRange } from "react-day-picker";
import { CalendarIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useIsMobile } from "@/hooks/use-mobile";
import type { DashboardPreset, DashboardRange, ReportRangePreset } from "@/lib/analyticsRange";
import { cn } from "@/lib/utils";
import {
  businessDateToCalendarDate,
  calendarDateToBusinessDate,
  type DashboardRangeValidationOptions,
  validateCustomDashboardRange,
} from "./dashboard-date-utils";

// react-day-picker loads when the custom range popover first opens, or
// earlier when the pointer or focus reaches its button. Until then the
// popover holds the calendar's size: one month below md, two from md.
const loadCalendar = () => import("@/components/ui/calendar");
const Calendar = dynamic(
  () => import("@/components/ui/calendar").then((m) => ({ default: m.Calendar })),
  { ssr: false, loading: () => <div aria-hidden="true" className="h-[294px] w-[212px] md:w-[424px]" /> },
);

export type DashboardRangePreset = DashboardPreset;

/**
 * The picker's range. Overview, Operations and lead gen keep the default
 * three presets; Reports widen it to `ReportRangePreset`.
 */
export type DashboardRangeInput<Preset extends ReportRangePreset = DashboardRangePreset> = DashboardRange<Preset>;

/** Every preset's name on the picker and in a range's words. */
export const RANGE_PRESET_LABELS: Record<ReportRangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
  last_month: "Last month",
  last_90_days: "Last 90 days",
  year_to_date: "Year to date",
};

export type RangePresetOption<Preset extends ReportRangePreset> = { value: Preset; label: string };

const presetOptions = <Preset extends ReportRangePreset>(values: readonly Preset[]): RangePresetOption<Preset>[] =>
  values.map((value) => ({ value, label: RANGE_PRESET_LABELS[value] }));

/** The dashboards' presets: Today, This week and This month. */
export const DASHBOARD_RANGE_PRESETS = presetOptions<DashboardRangePreset>(["today", "this_week", "this_month"]);

/** The presets in the picker's toggle and in its More menu, for a picker with more than three. */
export function rangePresetOptions<Preset extends ReportRangePreset>(toggle: readonly Preset[], more: readonly Preset[] = []) {
  return { presets: presetOptions(toggle), morePresets: presetOptions(more) };
}

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthDayYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const PRESET_PHRASES: Record<ReportRangePreset, string> = {
  today: "today",
  yesterday: "yesterday",
  this_week: "this week",
  last_week: "last week",
  this_month: "this month",
  last_month: "last month",
  last_90_days: "in the last 90 days",
  year_to_date: "this year",
};

/** How empty states name the range: "today", "this week", or "in this range". */
export function rangePhrase(range: DashboardRangeInput<ReportRangePreset>) {
  return range.kind === "custom" ? "in this range" : PRESET_PHRASES[range.preset];
}

/** "Oct 3 – Oct 17", with years only when a date is outside this year. */
export function formatBusinessDateSpan(start: string, endInclusive: string, todayBusinessDate: string) {
  const year = todayBusinessDate.slice(0, 4);
  const format = (dateKey: string) =>
    (dateKey.slice(0, 4) === year ? monthDay : monthDayYear).format(new Date(`${dateKey}T00:00:00Z`));
  return start === endInclusive ? format(start) : `${format(start)} – ${format(endInclusive)}`;
}

/**
 * The dashboards' date range: Today, This week and This month as one
 * segmented toggle, and a Custom range button that opens a two-month
 * calendar. Reports pass their own `presets`, and `morePresets` for a More
 * menu beside the toggle. `tone="board"` sets it on a navy page band;
 * `"paper"` on the page ground. Business-day rules and validation stay the
 * caller's.
 */
export function DateRangePicker<Preset extends ReportRangePreset = DashboardRangePreset>({
  value,
  onChange,
  presets = DASHBOARD_RANGE_PRESETS as RangePresetOption<Preset>[],
  morePresets = [],
  validationOptions,
  todayBusinessDate,
  tone = "paper",
  className,
}: {
  value: DashboardRangeInput<Preset>;
  onChange: (value: DashboardRangeInput<Preset>) => void;
  /** The toggle's presets. Defaults to Today, This week and This month. */
  presets?: readonly RangePresetOption<Preset>[];
  /** Presets in a More menu after the toggle. None by default. */
  morePresets?: readonly RangePresetOption<Preset>[];
  validationOptions?: DashboardRangeValidationOptions;
  /** Today's business date, to drop this year from the custom range's label. */
  todayBusinessDate?: string;
  tone?: "board" | "paper";
  className?: string;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [draftRange, setDraftRange] = useState<DateRange | undefined>(() =>
    value.kind === "custom"
      ? {
          from: businessDateToCalendarDate(value.startBusinessDate),
          to: businessDateToCalendarDate(value.endBusinessDateInclusive),
        }
      : undefined,
  );
  const draftBusinessRange = useMemo(
    () => ({
      startBusinessDate: draftRange?.from ? calendarDateToBusinessDate(draftRange.from) : undefined,
      endBusinessDateInclusive: draftRange?.to ? calendarDateToBusinessDate(draftRange.to) : undefined,
    }),
    [draftRange],
  );
  const draftError = validateCustomDashboardRange(draftBusinessRange, validationOptions);
  const onBoard = tone === "board";
  const chosenMore = value.kind === "preset" ? morePresets.find((entry) => entry.value === value.preset) : undefined;
  // The More and Custom range buttons: outlined, and filled while their range is shown.
  const outlineButtonClass = cn(
    "h-[34px] rounded-[7px] px-3 text-[13px]",
    onBoard
      ? // The band scopes `dark`, so the outline variant's dark fills are overridden here too.
        "border-board-foreground/15 bg-board-raised text-board-foreground hover:bg-board-foreground/10 hover:text-board-foreground dark:border-board-foreground/15 dark:bg-board-raised dark:hover:bg-board-foreground/10 aria-pressed:border-board-foreground aria-pressed:bg-board-foreground aria-pressed:text-board dark:aria-pressed:bg-board-foreground dark:aria-pressed:hover:bg-board-foreground/90"
      : "aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background dark:aria-pressed:bg-foreground",
  );
  const customLabel =
    value.kind === "custom"
      ? formatBusinessDateSpan(
          value.startBusinessDate,
          value.endBusinessDateInclusive,
          todayBusinessDate ?? value.endBusinessDateInclusive,
        )
      : "Custom range";

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      <ToggleGroup
        type="single"
        size="sm"
        value={value.kind === "preset" ? value.preset : ""}
        onValueChange={(next) => {
          const preset = presets.find((entry) => entry.value === next)?.value;
          if (preset) onChange({ kind: "preset", preset });
        }}
        aria-label="Date range"
        className={cn(
          "h-[34px] rounded-[7px] border p-0.5",
          onBoard ? "border-board-foreground/15 bg-board-raised" : "bg-muted",
        )}
      >
        {presets.map((preset) => (
          <ToggleGroupItem
            key={preset.value}
            value={preset.value}
            className={cn(
              "h-full rounded-[5px]! px-3 font-condensed text-[13px] font-semibold tracking-[0.1em] uppercase",
              onBoard
                ? "text-board-muted hover:bg-board-foreground/10 hover:text-board-foreground data-[state=on]:bg-board-foreground data-[state=on]:text-board"
                : "text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]",
            )}
          >
            {preset.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {morePresets.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" aria-pressed={chosenMore !== undefined} className={outlineButtonClass}>
              <span className={chosenMore ? "font-condensed text-[14px] font-semibold tracking-[0.02em]" : undefined}>
                {chosenMore?.label ?? "More"}
              </span>
              <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>More ranges</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={chosenMore?.value ?? ""}
              onValueChange={(next) => {
                const preset = morePresets.find((entry) => entry.value === next)?.value;
                if (preset) onChange({ kind: "preset", preset });
              }}
            >
              {morePresets.map((preset) => (
                <DropdownMenuRadioItem key={preset.value} value={preset.value}>
                  {preset.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next && value.kind === "custom") {
            setDraftRange({
              from: businessDateToCalendarDate(value.startBusinessDate),
              to: businessDateToCalendarDate(value.endBusinessDateInclusive),
            });
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            aria-pressed={value.kind === "custom"}
            onPointerEnter={loadCalendar}
            onFocus={loadCalendar}
            className={outlineButtonClass}
          >
            <CalendarIcon data-icon="inline-start" aria-hidden="true" />
            <span className={value.kind === "custom" ? "font-condensed text-[14px] font-semibold tracking-[0.02em]" : undefined}>
              {customLabel}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" collisionPadding={16} className="w-[calc(100vw-2rem)] max-w-fit p-2">
          <Calendar
            mode="range"
            autoFocus
            selected={draftRange}
            onSelect={setDraftRange}
            numberOfMonths={isMobile ? 1 : 2}
            showOutsideDays={isMobile}
            // The chosen ends are ink, like the pressed Custom range button:
            // the popover's one lime is its Show this range button.
            className="[&_[data-range-end=true]]:bg-foreground! [&_[data-range-end=true]]:text-background! [&_[data-range-start=true]]:bg-foreground! [&_[data-range-start=true]]:text-background!"
          />
          <div className="flex items-center justify-between gap-3 border-t px-2 pt-2">
            <p className={cn("min-w-0 text-[13px]", draftError ? "text-muted-foreground" : "text-foreground")}>
              {draftError ??
                formatBusinessDateSpan(
                  draftBusinessRange.startBusinessDate!,
                  draftBusinessRange.endBusinessDateInclusive!,
                  todayBusinessDate ?? draftBusinessRange.endBusinessDateInclusive!,
                )}
            </p>
            <Button
              size="sm"
              disabled={draftError !== null}
              onClick={() => {
                const { startBusinessDate, endBusinessDateInclusive } = draftBusinessRange;
                if (!startBusinessDate || !endBusinessDateInclusive) return;
                onChange({ kind: "custom", startBusinessDate, endBusinessDateInclusive });
                setOpen(false);
              }}
            >
              Show this range
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
