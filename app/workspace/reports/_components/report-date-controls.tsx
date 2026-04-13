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
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  startOfDay,
  endOfDay,
  subMonths,
  subDays,
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

const QUICK_PICKS = [
  {
    label: "Today",
    getRange: () => ({
      startDate: startOfDay(new Date()).getTime(),
      endDate: endOfDay(new Date()).getTime(),
    }),
  },
  {
    label: "This Week",
    getRange: () => ({
      startDate: startOfWeek(new Date()).getTime(),
      endDate: endOfWeek(new Date()).getTime(),
    }),
  },
  {
    label: "This Month",
    getRange: () => ({
      startDate: startOfMonth(new Date()).getTime(),
      endDate: endOfMonth(new Date()).getTime(),
    }),
  },
  {
    label: "Last Month",
    getRange: () => {
      const last = subMonths(new Date(), 1);
      return {
        startDate: startOfMonth(last).getTime(),
        endDate: endOfMonth(last).getTime(),
      };
    },
  },
  {
    label: "Last 90 Days",
    getRange: () => ({
      startDate: subDays(new Date(), 90).getTime(),
      endDate: new Date().getTime(),
    }),
  },
] as const;

export function ReportDateControls({
  value,
  onChange,
  granularity,
  onGranularityChange,
  showGranularity = false,
}: ReportDateControlsProps) {
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
            {format(value.endDate, "MMM d, yyyy")}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={{
              from: new Date(value.startDate),
              to: new Date(value.endDate),
            }}
            onSelect={(range) => {
              if (range?.from && range?.to) {
                onChange({
                  startDate: range.from.getTime(),
                  endDate: range.to.getTime(),
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
