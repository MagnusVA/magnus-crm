"use client";

import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ViewMode } from "./calendar-utils";

type CalendarHeaderProps = {
  viewMode: ViewMode;
  /** Human‑readable range label, e.g. "Mar 30 – Apr 5, 2026". */
  rangeLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onViewModeChange: (mode: ViewMode) => void;
};

/**
 * Calendar navigation bar.
 *
 * Left side: prev / Today / next buttons + range label.
 * Right side: Day | Week | Month toggle (shadcn Tabs used as a toggle group).
 */
export function CalendarHeader({
  viewMode,
  rangeLabel,
  onPrev,
  onNext,
  onToday,
  onViewModeChange,
}: CalendarHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {/* Left: navigation */}
      <div className="flex items-center gap-2">
        <div className="flex items-center">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onPrev}
            aria-label="Previous"
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onNext}
            aria-label="Next"
          >
            <ChevronRightIcon />
          </Button>
        </div>

        <Button variant="ghost" size="sm" onClick={onToday}>
          Today
        </Button>

        <h3 className="text-sm font-medium">{rangeLabel}</h3>
      </div>

      {/* Right: view mode toggle */}
      <Tabs
        value={viewMode}
        onValueChange={(v) => onViewModeChange(v as ViewMode)}
      >
        <TabsList>
          <TabsTrigger value="day">Day</TabsTrigger>
          <TabsTrigger value="week">Week</TabsTrigger>
          <TabsTrigger value="month">Month</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
