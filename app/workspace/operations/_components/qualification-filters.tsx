"use client";

import { SearchIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  OPERATIONS_PERIODS,
  type OperationsPeriod,
} from "./operations-period";

export type QualificationPrimaryFilter =
  | "none"
  | "status"
  | "bookingProgram"
  | "soldProgram"
  | "slackUser"
  | "attributionTeam"
  | "dmCloser";

type FilterOption = {
  id: string;
  name: string;
};

export type QualificationFilterOptions = {
  programs: Array<{ id: Id<"tenantPrograms">; name: string }>;
  slackUsers: FilterOption[];
  attributionTeams: Array<{ id: Id<"attributionTeams">; name: string }>;
  dmClosers: Array<{ id: Id<"dmClosers">; name: string }>;
  closers: Array<{ id: Id<"users">; name: string }>;
};

type QualificationFiltersProps = {
  searchTerm: string;
  onSearchTermChange: (value: string) => void;
  period: OperationsPeriod;
  onPeriodChange: (value: OperationsPeriod) => void;
  primaryFilter: QualificationPrimaryFilter;
  onPrimaryFilterChange: (value: QualificationPrimaryFilter) => void;
  primaryValue: string;
  onPrimaryValueChange: (value: string) => void;
  options?: QualificationFilterOptions;
};

const STATUS_OPTIONS = [
  { id: "qualified_pending", name: "Qualified pending" },
  { id: "scheduled", name: "Scheduled" },
  { id: "payment_received", name: "Payment received" },
  { id: "follow_up_scheduled", name: "Follow-up scheduled" },
  { id: "reschedule_link_sent", name: "Reschedule link sent" },
  { id: "lost", name: "Lost" },
  { id: "canceled", name: "Canceled" },
  { id: "no_show", name: "No show" },
];

const PRIMARY_FILTER_OPTIONS = [
  { id: "none", name: "No primary filter" },
  { id: "status", name: "Status" },
  { id: "bookingProgram", name: "Booked program" },
  { id: "soldProgram", name: "Sold program" },
  { id: "slackUser", name: "Slack qualifier" },
  { id: "attributionTeam", name: "DM team" },
  { id: "dmCloser", name: "DM closer" },
] satisfies Array<{ id: QualificationPrimaryFilter; name: string }>;

function getPrimaryValueOptions(
  filter: QualificationPrimaryFilter,
  options?: QualificationFilterOptions,
): FilterOption[] {
  if (filter === "status") {
    return STATUS_OPTIONS;
  }
  if (filter === "bookingProgram" || filter === "soldProgram") {
    return options?.programs ?? [];
  }
  if (filter === "slackUser") {
    return options?.slackUsers ?? [];
  }
  if (filter === "attributionTeam") {
    return options?.attributionTeams ?? [];
  }
  if (filter === "dmCloser") {
    return options?.dmClosers ?? [];
  }
  return [];
}

export function QualificationFilters({
  searchTerm,
  onSearchTermChange,
  period,
  onPeriodChange,
  primaryFilter,
  onPrimaryFilterChange,
  primaryValue,
  onPrimaryValueChange,
  options,
}: QualificationFiltersProps) {
  const valueOptions = getPrimaryValueOptions(primaryFilter, options);
  const hasPrimaryValue = primaryFilter !== "none";

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(event) => onSearchTermChange(event.target.value)}
            placeholder="Search lead, handle, status, or program"
            className="pl-8"
          />
        </div>

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
            onValueChange={(value) =>
              onPrimaryFilterChange(value as QualificationPrimaryFilter)
            }
          >
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="Primary filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {PRIMARY_FILTER_OPTIONS.map((option) => (
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
