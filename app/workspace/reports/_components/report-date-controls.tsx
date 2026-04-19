"use client";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CalendarIcon } from "lucide-react";
import {
  addDays,
  format,
  startOfDay,
  subDays,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";

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

function getDisplayEndDate(endDate: number): Date {
  const end = new Date(endDate);
  const isExactMidnight =
    end.getHours() === 0 &&
    end.getMinutes() === 0 &&
    end.getSeconds() === 0 &&
    end.getMilliseconds() === 0;

  if (isExactMidnight) {
    end.setDate(end.getDate() - 1);
  }

  return end;
}

const QUICK_PICKS = [
  {
    label: "Today",
    getRange: () => {
      const now = new Date();
      return {
        startDate: getStartOfDayTimestamp(now),
        endDate: getExclusiveUpperTimestamp(now),
      };
    },
  },
  {
    label: "This Week",
    getRange: () => {
      const now = new Date();
      return {
        startDate: startOfWeek(now).getTime(),
        endDate: getExclusiveUpperTimestamp(now),
      };
    },
  },
  {
    label: "This Month",
    getRange: () => {
      const now = new Date();
      return {
        startDate: startOfMonth(now).getTime(),
        endDate: getExclusiveUpperTimestamp(now),
      };
    },
  },
  {
    label: "Last Month",
    getRange: () => {
      const now = new Date();
      const last = subMonths(now, 1);
      return {
        startDate: startOfMonth(last).getTime(),
        endDate: startOfMonth(now).getTime(),
      };
    },
  },
  {
    label: "Last 90 Days",
    getRange: () => {
      const now = new Date();
      return {
        startDate: subDays(startOfDay(now), 89).getTime(),
        endDate: getExclusiveUpperTimestamp(now),
      };
    },
  },
] as const;

export function ReportDateControls({
  value,
  onChange,
  granularity,
  onGranularityChange,
  showGranularity = false,
}: ReportDateControlsProps) {
  const displayEndDate = getDisplayEndDate(value.endDate);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Quick pick buttons */}
      {QUICK_PICKS.map((pick) => (
        <Button
          key={pick.label}
          variant="outline"
          size="sm"
          onClick={() => onChange(pick.getRange())}
        >
          {pick.label}
        </Button>
      ))}

      {/* Custom date range picker */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <CalendarIcon className="mr-2 h-4 w-4" />
            {format(value.startDate, "MMM d")} –{" "}
            {format(displayEndDate, "MMM d, yyyy")}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={{
              from: new Date(value.startDate),
              to: displayEndDate,
            }}
            onSelect={(range) => {
              if (range?.from && range?.to) {
                onChange({
                  startDate: getStartOfDayTimestamp(range.from),
                  endDate: getExclusiveUpperTimestamp(range.to),
                });
              }
            }}
          />
        </PopoverContent>
      </Popover>

      {/* Granularity toggle (for trend charts) */}
      {showGranularity && onGranularityChange && (
        <Select
          value={granularity}
          onValueChange={(v) => onGranularityChange(v as Granularity)}
        >
          <SelectTrigger className="w-[100px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="day">Day</SelectItem>
            <SelectItem value="week">Week</SelectItem>
            <SelectItem value="month">Month</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export type { DateRange, Granularity, ReportDateControlsProps };
