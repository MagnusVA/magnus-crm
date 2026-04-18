"use client";

import { useCallback } from "react";
import {
  addDays,
  subDays,
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
} from "date-fns";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarHeader } from "./calendar-header";
import { DayView } from "./day-view";
import { WeekView } from "./week-view";
import { MonthView } from "./month-view";
import { CloserEmptyState } from "./closer-empty-state";
import type { ViewMode } from "./calendar-utils";

type CalendarViewProps = {
  viewMode: ViewMode;
  currentDate: Date;
  /** Range start, inclusive (Unix ms). Computed by the parent. */
  startDate: number;
  /** Range end, exclusive (Unix ms). Computed by the parent. */
  endDate: number;
  /** Human‑readable range label, e.g. "Mar 30 – Apr 5, 2026". */
  rangeLabel: string;
  onViewModeChange: (mode: ViewMode) => void;
  onCurrentDateChange: (date: Date) => void;
};

/**
 * Calendar component for the closer dashboard.
 *
 * State (`viewMode`, `currentDate`) is owned by the parent so the same range
 * also drives the pipeline stats strip. This component delegates rendering
 * to DayView / WeekView / MonthView and handles its own navigation buttons.
 */
export function CalendarView({
  viewMode,
  currentDate,
  startDate,
  endDate,
  rangeLabel,
  onViewModeChange,
  onCurrentDateChange,
}: CalendarViewProps) {
  const meetings = useQuery(api.closer.calendar.getMeetingsForRange, {
    startDate,
    endDate,
  });

  // ── Navigation callbacks (stable via useCallback) ───────────────────────
  const goToday = useCallback(
    () => onCurrentDateChange(new Date()),
    [onCurrentDateChange],
  );

  const goPrev = useCallback(() => {
    if (viewMode === "day") onCurrentDateChange(subDays(currentDate, 1));
    else if (viewMode === "week") onCurrentDateChange(subWeeks(currentDate, 1));
    else onCurrentDateChange(subMonths(currentDate, 1));
  }, [viewMode, currentDate, onCurrentDateChange]);

  const goNext = useCallback(() => {
    if (viewMode === "day") onCurrentDateChange(addDays(currentDate, 1));
    else if (viewMode === "week") onCurrentDateChange(addWeeks(currentDate, 1));
    else onCurrentDateChange(addMonths(currentDate, 1));
  }, [viewMode, currentDate, onCurrentDateChange]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <section aria-label={`Calendar — ${rangeLabel}`} className="flex flex-col gap-4">
      <CalendarHeader
        viewMode={viewMode}
        rangeLabel={rangeLabel}
        onPrev={goPrev}
        onNext={goNext}
        onToday={goToday}
        onViewModeChange={onViewModeChange}
      />

      {meetings === undefined ? (
        <CalendarSkeleton viewMode={viewMode} />
      ) : meetings.length === 0 ? (
        <CloserEmptyState
          title="No meetings this period"
          description="There are no meetings scheduled in the selected date range. Navigate to a different period or check back later."
        />
      ) : viewMode === "day" ? (
        <DayView meetings={meetings} date={currentDate} />
      ) : viewMode === "week" ? (
        <WeekView
          meetings={meetings}
          startDate={new Date(startDate)}
        />
      ) : (
        <MonthView meetings={meetings} month={currentDate} />
      )}
    </section>
  );
}

// ─── Loading skeleton ────────────────────────────────────────────────────────

function CalendarSkeleton({ viewMode }: { viewMode: ViewMode }) {
  if (viewMode === "month") {
    return (
      <div className="grid grid-cols-7 gap-px rounded-lg border p-2">
        {Array.from({ length: 35 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-md" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-[52px] rounded-md" />
      ))}
    </div>
  );
}
