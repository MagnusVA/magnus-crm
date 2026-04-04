"use client";

import { useState, useMemo, useCallback } from "react";
import {
  format,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfDay,
  endOfDay,
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

/**
 * Self‑contained calendar component for the closer dashboard.
 *
 * Manages its own state (current date + view mode), computes the
 * query date range, and delegates rendering to DayView / WeekView /
 * MonthView.  The range params are memoised so the Convex subscription
 * only updates when the user actually navigates to a different period.
 */
export function CalendarView() {
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [currentDate, setCurrentDate] = useState(() => new Date());

  // ── Date range for the Convex query ─────────────────────────────────────
  const { startDate, endDate } = useMemo(() => {
    let start: Date;
    let end: Date;

    if (viewMode === "day") {
      start = startOfDay(currentDate);
      end = endOfDay(currentDate);
    } else if (viewMode === "week") {
      start = startOfWeek(currentDate); // Sunday
      end = endOfWeek(currentDate); // Saturday 23:59:59
    } else {
      // month — extend to fill calendar grid (prev/next month partials)
      start = startOfWeek(startOfMonth(currentDate));
      end = endOfWeek(endOfMonth(currentDate));
    }

    return { startDate: start.getTime(), endDate: end.getTime() };
  }, [currentDate, viewMode]);

  const meetings = useQuery(api.closer.calendar.getMeetingsForRange, {
    startDate,
    endDate,
  });

  // ── Navigation callbacks (stable via useCallback) ───────────────────────
  const goToday = useCallback(() => setCurrentDate(new Date()), []);

  const goPrev = useCallback(() => {
    setCurrentDate((prev) => {
      if (viewMode === "day") return subDays(prev, 1);
      if (viewMode === "week") return subWeeks(prev, 1);
      return subMonths(prev, 1);
    });
  }, [viewMode]);

  const goNext = useCallback(() => {
    setCurrentDate((prev) => {
      if (viewMode === "day") return addDays(prev, 1);
      if (viewMode === "week") return addWeeks(prev, 1);
      return addMonths(prev, 1);
    });
  }, [viewMode]);

  // ── Range label (header) ────────────────────────────────────────────────
  const rangeLabel = useMemo(() => {
    if (viewMode === "day") {
      return format(currentDate, "EEEE, MMMM d, yyyy");
    }
    if (viewMode === "week") {
      const ws = startOfWeek(currentDate);
      const we = endOfWeek(currentDate);
      // Same month: "Mar 30 – Apr 5, 2026"
      return `${format(ws, "MMM d")} – ${format(we, "MMM d, yyyy")}`;
    }
    return format(currentDate, "MMMM yyyy");
  }, [currentDate, viewMode]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <section aria-label={`Calendar — ${rangeLabel}`} className="flex flex-col gap-4">
      <CalendarHeader
        viewMode={viewMode}
        rangeLabel={rangeLabel}
        onPrev={goPrev}
        onNext={goNext}
        onToday={goToday}
        onViewModeChange={setViewMode}
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
