"use client";

import { CalendarView } from "./calendar-view";

/**
 * Calendar section — wraps the calendar view.
 * In Phase 4, this will be lazy-loaded via dynamic().
 */
export function CalendarSection() {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-pretty">
        My Schedule
      </h2>
      <CalendarView />
    </div>
  );
}
