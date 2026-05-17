"use client";

import { useState } from "react";
import type { DateRange as CalendarDateRange } from "react-day-picker";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addBusinessDays,
  businessDateToCalendarDate,
  calendarDateToBusinessDate,
  getInclusiveEndBusinessDate,
  getQuickRange,
  type SlackQualificationFilters,
  type SlackQualificationGranularity,
} from "./business-date-utils";

type SetterOption = {
  slackUserId: string;
  displayName: string;
  isDeleted: boolean;
};

type SetterQualificationControlsProps = {
  setters: SetterOption[];
  value: SlackQualificationFilters;
  onChange: (value: SlackQualificationFilters) => void;
};

const QUICK_PICKS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "This Week" },
  { key: "this_month", label: "This Month" },
  { key: "last_30", label: "Last 30 Business Days" },
] as const;

export function SetterQualificationControls({
  setters,
  value,
  onChange,
}: SetterQualificationControlsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [pendingRange, setPendingRange] = useState<
    CalendarDateRange | undefined
  >(undefined);

  const inclusiveEnd = getInclusiveEndBusinessDate(
    value.endBusinessDateExclusive,
  );
  const canApply = Boolean(pendingRange?.from && pendingRange?.to);

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
    <div className="flex flex-wrap items-center gap-2">
      {QUICK_PICKS.map((pick) => (
        <Button
          key={pick.key}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange({ ...value, ...getQuickRange(pick.key) })}
        >
          {pick.label}
        </Button>
      ))}

      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <CalendarIcon data-icon="inline-start" />
            {format(
              businessDateToCalendarDate(value.startBusinessDate),
              "MMM d",
            )}{" "}
            - {format(businessDateToCalendarDate(inclusiveEnd), "MMM d, yyyy")}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={pendingRange}
            onSelect={(range) => setPendingRange(range)}
          />
          <div className="flex items-center justify-end gap-2 border-t p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setIsOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={applyPendingRange}
              disabled={!canApply}
            >
              Apply
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
        <SelectTrigger size="sm" className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="day">Day</SelectItem>
            <SelectItem value="week">Week</SelectItem>
            <SelectItem value="month">Month</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>

      <Select
        value={value.slackUserId ?? "all"}
        onValueChange={(slackUserId) =>
          onChange({
            ...value,
            slackUserId: slackUserId === "all" ? null : slackUserId,
          })
        }
      >
        <SelectTrigger size="sm" className="w-56 max-w-full">
          <SelectValue placeholder="All setters" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All setters</SelectItem>
            {setters.map((setter) => (
              <SelectItem
                key={setter.slackUserId}
                value={setter.slackUserId}
              >
                {setter.displayName}
                {setter.isDeleted ? " (deactivated)" : ""}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
