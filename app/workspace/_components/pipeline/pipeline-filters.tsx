"use client";

import { useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { TimePeriod } from "@/app/workspace/_components/time-period-filter";
import {
  CLOSER_PIPELINE_TABS,
  type CloserPipelineTab,
} from "@/convex/closer/pipelineTabs";
import {
  DEAL_POSITION_LABELS,
  type DealPosition,
} from "@/convex/opportunities/stages";

export type PipelinePeriod = TimePeriod | "all";

const ALL_TAB = "all";

const PERIOD_OPTIONS = [
  { value: "all", label: "All time" },
  { value: "today", label: "Day" },
  { value: "this_week", label: "Week" },
  { value: "this_month", label: "Month" },
] as const;

export interface PipelineFiltersProps {
  /** The tab shown, or null for All. */
  stageFilter: CloserPipelineTab | null;
  periodFilter: PipelinePeriod;
  onStageChange: (stage: CloserPipelineTab | null) => void;
  onPeriodChange: (period: PipelinePeriod) => void;
  /** The closer's deals at each position, all time. */
  counts: Record<DealPosition, number>;
  /** All the closer's deals, the All tab's count. */
  total: number;
}

export function PipelineFilters({
  stageFilter,
  periodFilter,
  onStageChange,
  onPeriodChange,
  counts,
  total,
}: PipelineFiltersProps) {
  const handleStageChange = useCallback(
    (next: string) => {
      onStageChange(CLOSER_PIPELINE_TABS.find((tab) => tab === next) ?? null);
    },
    [onStageChange],
  );

  const handlePeriodChange = useCallback(
    (next: string) => {
      // ToggleGroup fires "" when deselecting — keep current value.
      if (next) {
        onPeriodChange(next as PipelinePeriod);
      }
    },
    [onPeriodChange],
  );

  const tabs = [
    { value: ALL_TAB, label: "All", count: total },
    ...CLOSER_PIPELINE_TABS.map((tab) => ({
      value: tab,
      label: DEAL_POSITION_LABELS[tab],
      count: counts[tab],
    })),
  ];

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-3 text-sm font-medium">Stage</p>
            <Tabs value={stageFilter ?? ALL_TAB} onValueChange={handleStageChange}>
              <TabsList className="grid h-auto w-full grid-cols-3 lg:grid-cols-6">
                {tabs.map((tab) => (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    className="gap-1 text-xs"
                  >
                    {tab.label}
                    <Badge
                      variant="secondary"
                      className="px-1.5 py-0 text-[10px]"
                    >
                      {tab.count}
                    </Badge>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
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
