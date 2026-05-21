"use client";

import type { Id } from "@/convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { QualificationFilterOptions } from "./qualification-filters";
import {
  OPERATIONS_PERIODS,
  type OperationsPeriod,
} from "./operations-period";

export type SchedulingPrimaryFilter =
  | "none"
  | "bookingProgram"
  | "soldProgram"
  | "slackUser"
  | "phoneCloser"
  | "attributionTeam"
  | "dmCloser";

export type PhoneSalesPrimaryFilter =
  | "none"
  | "phoneCloser"
  | "bookingProgram"
  | "soldProgram"
  | "meetingStatus"
  | "opportunityStatus"
  | "attributionTeam"
  | "dmCloser";

type FilterOption = {
  id: string;
  name: string;
};

type MeetingStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "canceled"
  | "no_show"
  | "meeting_overran";

type OpportunityStatus =
  | "qualified_pending"
  | "scheduled"
  | "in_progress"
  | "meeting_overran"
  | "payment_received"
  | "follow_up_scheduled"
  | "reschedule_link_sent"
  | "lost"
  | "canceled"
  | "no_show";

type OperationsFilterBarProps<TPrimaryFilter extends string> = {
  period: OperationsPeriod;
  onPeriodChange: (value: OperationsPeriod) => void;
  primaryFilter: TPrimaryFilter;
  onPrimaryFilterChange: (value: TPrimaryFilter) => void;
  primaryValue: string;
  onPrimaryValueChange: (value: string) => void;
  primaryFilterOptions: Array<{ id: TPrimaryFilter; name: string }>;
  valueOptions: FilterOption[];
  note: string;
};

export const SCHEDULING_PRIMARY_FILTER_OPTIONS = [
  { id: "none", name: "No primary filter" },
  { id: "bookingProgram", name: "Booked program" },
  { id: "soldProgram", name: "Sold program" },
  { id: "slackUser", name: "Slack qualifier" },
  { id: "phoneCloser", name: "Phone closer" },
  { id: "attributionTeam", name: "DM team" },
  { id: "dmCloser", name: "DM closer" },
] satisfies Array<{ id: SchedulingPrimaryFilter; name: string }>;

export const PHONE_SALES_PRIMARY_FILTER_OPTIONS = [
  { id: "none", name: "No primary filter" },
  { id: "phoneCloser", name: "Phone closer" },
  { id: "bookingProgram", name: "Booked program" },
  { id: "soldProgram", name: "Sold program" },
  { id: "meetingStatus", name: "Meeting status" },
  { id: "opportunityStatus", name: "Opportunity status" },
  { id: "attributionTeam", name: "DM team" },
  { id: "dmCloser", name: "DM closer" },
] satisfies Array<{ id: PhoneSalesPrimaryFilter; name: string }>;

export const MEETING_STATUS_OPTIONS = [
  { id: "scheduled", name: "Scheduled" },
  { id: "in_progress", name: "In progress" },
  { id: "completed", name: "Completed" },
  { id: "canceled", name: "Canceled" },
  { id: "no_show", name: "No show" },
  { id: "meeting_overran", name: "Meeting overran" },
];

export const OPPORTUNITY_STATUS_OPTIONS = [
  { id: "qualified_pending", name: "Qualified pending" },
  { id: "scheduled", name: "Scheduled" },
  { id: "in_progress", name: "In progress" },
  { id: "meeting_overran", name: "Meeting overran" },
  { id: "payment_received", name: "Payment received" },
  { id: "follow_up_scheduled", name: "Follow-up scheduled" },
  { id: "reschedule_link_sent", name: "Reschedule link sent" },
  { id: "lost", name: "Lost" },
  { id: "canceled", name: "Canceled" },
  { id: "no_show", name: "No show" },
];

export function getSchedulingValueOptions(
  filter: SchedulingPrimaryFilter,
  options?: QualificationFilterOptions,
): FilterOption[] {
  if (filter === "bookingProgram" || filter === "soldProgram") {
    return options?.programs ?? [];
  }
  if (filter === "slackUser") {
    return options?.slackUsers ?? [];
  }
  if (filter === "phoneCloser") {
    return options?.closers ?? [];
  }
  if (filter === "attributionTeam") {
    return options?.attributionTeams ?? [];
  }
  if (filter === "dmCloser") {
    return options?.dmClosers ?? [];
  }
  return [];
}

export function getPhoneSalesValueOptions(
  filter: PhoneSalesPrimaryFilter,
  options?: QualificationFilterOptions,
): FilterOption[] {
  if (filter === "meetingStatus") {
    return MEETING_STATUS_OPTIONS;
  }
  if (filter === "opportunityStatus") {
    return OPPORTUNITY_STATUS_OPTIONS;
  }
  return getSchedulingValueOptions(
    filter === "phoneCloser" ? "phoneCloser" : filter,
    options,
  );
}

export function buildSchedulingPrimaryArgs(
  filter: SchedulingPrimaryFilter,
  value: string,
) {
  if (filter === "none" || value === "all") return {};
  if (filter === "bookingProgram") {
    return { bookingProgramId: value as Id<"tenantPrograms"> };
  }
  if (filter === "soldProgram") {
    return { soldProgramId: value as Id<"tenantPrograms"> };
  }
  if (filter === "slackUser") return { slackUserId: value };
  if (filter === "phoneCloser") {
    return { assignedCloserId: value as Id<"users"> };
  }
  if (filter === "attributionTeam") {
    return { attributionTeamId: value as Id<"attributionTeams"> };
  }
  if (filter === "dmCloser") return { dmCloserId: value as Id<"dmClosers"> };
  return {};
}

export function buildPhoneSalesPrimaryArgs(
  filter: PhoneSalesPrimaryFilter,
  value: string,
) {
  if (filter === "none" || value === "all") return {};
  if (filter === "phoneCloser") return { closerId: value as Id<"users"> };
  if (filter === "bookingProgram") {
    return { bookingProgramId: value as Id<"tenantPrograms"> };
  }
  if (filter === "soldProgram") {
    return { soldProgramId: value as Id<"tenantPrograms"> };
  }
  if (filter === "meetingStatus") {
    return { meetingStatus: value as MeetingStatus };
  }
  if (filter === "opportunityStatus") {
    return { opportunityStatus: value as OpportunityStatus };
  }
  if (filter === "attributionTeam") {
    return { attributionTeamId: value as Id<"attributionTeams"> };
  }
  if (filter === "dmCloser") return { dmCloserId: value as Id<"dmClosers"> };
  return {};
}

export function OperationsFilterBar<TPrimaryFilter extends string>({
  period,
  onPeriodChange,
  primaryFilter,
  onPrimaryFilterChange,
  primaryValue,
  onPrimaryValueChange,
  primaryFilterOptions,
  valueOptions,
  note,
}: OperationsFilterBarProps<TPrimaryFilter>) {
  const hasPrimaryValue = primaryFilter !== "none";

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="text-sm text-muted-foreground">{note}</div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Select
            value={period}
            onValueChange={(value) => onPeriodChange(value as OperationsPeriod)}
          >
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue placeholder="Period" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {OPERATIONS_PERIODS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select
            value={primaryFilter}
            onValueChange={(value) => {
              onPrimaryFilterChange(value as TPrimaryFilter);
              onPrimaryValueChange("all");
            }}
          >
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="Primary filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {primaryFilterOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select
            value={hasPrimaryValue ? primaryValue : "all"}
            onValueChange={onPrimaryValueChange}
            disabled={!hasPrimaryValue}
          >
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue placeholder="Value" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All values</SelectItem>
                {valueOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
