"use client";

import { useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { TimePeriod } from "@/app/workspace/_components/time-period-filter";

export type PipelinePeriod = TimePeriod | "all";

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "in_progress", label: "In Progress" },
  { value: "meeting_overran", label: "Meeting Overran" },
  { value: "follow_up_scheduled", label: "Follow-up" },
  { value: "payment_received", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "canceled", label: "Canceled" },
  { value: "no_show", label: "No Show" },
];

const PERIOD_OPTIONS = [
  { value: "all", label: "All time" },
  { value: "today", label: "Day" },
  { value: "this_week", label: "Week" },
  { value: "this_month", label: "Month" },
] as const;

export interface PipelineFiltersProps {
  statusFilter: string;
  periodFilter: PipelinePeriod;
  onStatusChange: (status: string) => void;
  onPeriodChange: (period: PipelinePeriod) => void;
  /**
   * Optional closer filter. When `closers` is provided, the Closer select is
   * rendered and `closerFilter`/`onCloserChange` MUST also be provided. Omit
   * the entire triple to hide the Closer filter (closer view).
   */
  closerFilter?: string;
  onCloserChange?: (closerId: string) => void;
  closers?: Array<{ _id: string; fullName?: string; email: string }>;
  /**
   * Optional per-status counts. When provided, each status tab renders a
   * count badge (used by the closer view). Omit for the admin view.
   */
  counts?: Record<string, number>;
  /** Total across all statuses — used for the "All" tab badge. */
  total?: number;
}

export function PipelineFilters({
  statusFilter,
  periodFilter,
  onStatusChange,
  onPeriodChange,
  closerFilter,
  onCloserChange,
  closers,
  counts,
  total,
}: PipelineFiltersProps) {
  const handlePeriodChange = useCallback(
    (next: string) => {
      // ToggleGroup fires "" when deselecting — keep current value.
      if (next) {
        onPeriodChange(next as PipelinePeriod);
      }
    },
    [onPeriodChange],
  );

  const showCloserFilter = Boolean(closers && onCloserChange);
  const showCounts = Boolean(counts);

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex-1">
              <p className="mb-3 text-sm font-medium">Status</p>
              <Tabs value={statusFilter} onValueChange={onStatusChange}>
                <TabsList className="grid h-auto w-full grid-cols-3 lg:grid-cols-9">
                  {STATUS_OPTIONS.map((status) => {
                    const count =
                      status.value === "all"
                        ? total
                        : counts?.[status.value];
                    return (
                      <TabsTrigger
                        key={status.value}
                        value={status.value}
                        className="gap-1 text-xs"
                      >
                        {status.label}
                        {showCounts && count !== undefined ? (
                          <Badge
                            variant="secondary"
                            className="px-1.5 py-0 text-[10px]"
                          >
                            {count}
                          </Badge>
                        ) : null}
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </Tabs>
            </div>

            {showCloserFilter ? (
              <div className="w-full md:w-48">
                <p className="mb-3 text-sm font-medium">Closer</p>
                <Select
                  value={closerFilter ?? "all"}
                  onValueChange={onCloserChange}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All closers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All closers</SelectItem>
                    {closers?.map((closer) => (
                      <SelectItem key={closer._id} value={closer._id}>
                        {closer.fullName || closer.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <div>
            <p className="mb-3 text-sm font-medium">Time Period</p>
            <ToggleGroup
              type="single"
              value={periodFilter}
              onValueChange={handlePeriodChange}
              variant="outline"
              size="sm"
              aria-label="Filter pipeline by time period"
            >
              {PERIOD_OPTIONS.map((opt) => (
                <ToggleGroupItem
                  key={opt.value}
                  value={opt.value}
                  aria-label={opt.label}
                >
                  {opt.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
