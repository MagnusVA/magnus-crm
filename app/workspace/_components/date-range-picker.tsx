"use client";

import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import {
  businessDateToCalendarDate,
  calendarDateToBusinessDate,
  type DashboardRangeValidationOptions,
  validateCustomDashboardRange,
} from "./dashboard-date-utils";

export type DashboardRangePreset = "today" | "this_week" | "this_month";

export type DashboardRangeInput =
  | { kind: "preset"; preset: DashboardRangePreset }
  | {
      kind: "custom";
      startBusinessDate: string;
      endBusinessDateInclusive: string;
    };

const PRESETS: ReadonlyArray<{ value: DashboardRangePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "this_month", label: "This month" },
];

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthDayYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** How empty states name the range: "today", "this week", or "in this range". */
export function rangePhrase(range: DashboardRangeInput) {
  if (range.kind === "custom") return "in this range";
  return range.preset === "today" ? "today" : range.preset === "this_week" ? "this week" : "this month";
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
 * calendar. `tone="board"` sets it on a navy page band; `"paper"` on the
 * page ground. Business-day rules and validation stay the caller's.
 */
export function DateRangePicker({
  value,
  onChange,
  validationOptions,
  todayBusinessDate,
  tone = "paper",
  className,
}: {
  value: DashboardRangeInput;
  onChange: (value: DashboardRangeInput) => void;
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
          const preset = PRESETS.find((entry) => entry.value === next)?.value;
          if (preset) onChange({ kind: "preset", preset });
        }}
        aria-label="Date range"
        className={cn(
          "h-[34px] rounded-[7px] border p-0.5",
          onBoard ? "border-board-foreground/15 bg-board-raised" : "bg-muted",
        )}
      >
        {PRESETS.map((preset) => (
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
            className={cn(
              "h-[34px] rounded-[7px] px-3 text-[13px]",
              onBoard
                ? // The band scopes `dark`, so the outline variant's dark fills are overridden here too.
                  "border-board-foreground/15 bg-board-raised text-board-foreground hover:bg-board-foreground/10 hover:text-board-foreground dark:border-board-foreground/15 dark:bg-board-raised dark:hover:bg-board-foreground/10 aria-pressed:border-board-foreground aria-pressed:bg-board-foreground aria-pressed:text-board dark:aria-pressed:bg-board-foreground dark:aria-pressed:hover:bg-board-foreground/90"
                : "aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background dark:aria-pressed:bg-foreground",
            )}
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
