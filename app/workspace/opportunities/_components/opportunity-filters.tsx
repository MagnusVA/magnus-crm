"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  PeriodFilter,
  SourceFilter,
  StatusFilter,
} from "./opportunities-page-client";

type OpportunityFiltersProps = {
  isAdmin: boolean;
  statusFilter: StatusFilter;
  sourceFilter: SourceFilter;
  periodFilter: PeriodFilter;
  closerFilter: Id<"users"> | "all";
  onStatusChange: (value: StatusFilter) => void;
  onSourceChange: (value: SourceFilter) => void;
  onPeriodChange: (value: PeriodFilter) => void;
  onCloserChange: (value: Id<"users"> | "all") => void;
};

export function OpportunityFilters({
  isAdmin,
  statusFilter,
  sourceFilter,
  periodFilter,
  closerFilter,
  onStatusChange,
  onSourceChange,
  onPeriodChange,
  onCloserChange,
}: OpportunityFiltersProps) {
  const closers = useQuery(
    api.users.queries.listActiveClosers,
    isAdmin ? {} : "skip",
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={periodFilter}
          onValueChange={(value) => {
            if (value) {
              onPeriodChange(value as PeriodFilter);
            }
          }}
          size="sm"
          variant="outline"
        >
          <ToggleGroupItem value="all">All time</ToggleGroupItem>
          <ToggleGroupItem value="today">Today</ToggleGroupItem>
          <ToggleGroupItem value="this_week">Week</ToggleGroupItem>
          <ToggleGroupItem value="this_month">Month</ToggleGroupItem>
        </ToggleGroup>

        <ToggleGroup
          type="single"
          value={sourceFilter}
          onValueChange={(value) => {
            if (value) {
              onSourceChange(value as SourceFilter);
            }
          }}
          size="sm"
          variant="outline"
        >
          <ToggleGroupItem value="all">All sources</ToggleGroupItem>
          <ToggleGroupItem value="calendly">Calendly</ToggleGroupItem>
          <ToggleGroupItem value="side_deal">Side deals</ToggleGroupItem>
        </ToggleGroup>

        {isAdmin ? (
          <Select
            value={closerFilter}
            onValueChange={(value) =>
              onCloserChange(value as Id<"users"> | "all")
            }
          >
            <SelectTrigger size="sm" className="w-full sm:w-48">
              <SelectValue placeholder="All closers" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All closers</SelectItem>
                {closers?.map((closer) => (
                  <SelectItem key={closer._id} value={closer._id}>
                    {closer.fullName ?? closer.email}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <Tabs
        value={statusFilter}
        onValueChange={(value) => onStatusChange(value as StatusFilter)}
      >
        <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-3 lg:inline-flex lg:w-fit">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="in_progress">In Progress</TabsTrigger>
          <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
          <TabsTrigger value="payment_received">Won</TabsTrigger>
          <TabsTrigger value="lost">Lost</TabsTrigger>
          <TabsTrigger value="canceled">Canceled</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
