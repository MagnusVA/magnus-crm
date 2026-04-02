/**
 * Shared types, constants, and helpers for calendar view components.
 *
 * Extracted to avoid duplication across day-view, week-view, and month-view.
 */

// ─── Shared types ───────────────────────────────────────────────────────────

/** Calendar view mode used by the header toggle and view renderer. */
export type ViewMode = "day" | "week" | "month";

/** Meeting data enriched with lead and event-type info (returned by getMeetingsForRange). */
export type EnrichedMeeting = {
  meeting: {
    _id: string;
    scheduledAt: number;
    durationMinutes: number;
    status: string;
  };
  leadName: string;
  eventTypeName?: string | null;
};

// ─── Time grid constants ────────────────────────────────────────────────────

/** First visible hour row. */
export const START_HOUR = 7;
/** Last visible hour row (exclusive — 21 means 9 PM is the final label). */
export const END_HOUR = 21;
/** Pixel height for a one-hour slot. */
export const HOUR_HEIGHT = 60;

/** Array of visible hours (7 → 20). */
export const HOURS = Array.from(
  { length: END_HOUR - START_HOUR },
  (_, i) => START_HOUR + i,
);

// ─── Positioning helpers ────────────────────────────────────────────────────

/** Convert a scheduledAt timestamp to a top-offset in pixels within the time grid. */
export function getTopPx(scheduledAt: number): number {
  const d = new Date(scheduledAt);
  return (
    (d.getHours() - START_HOUR) * HOUR_HEIGHT +
    (d.getMinutes() / 60) * HOUR_HEIGHT
  );
}

/** Convert a meeting duration to a height in pixels (minimum 20px to stay visible). */
export function getHeightPx(durationMinutes: number): number {
  return Math.max((durationMinutes / 60) * HOUR_HEIGHT, 20);
}

/** Format an hour number (0–23) as a 12-hour label, e.g. "7 AM", "1 PM". */
export function formatHour(hour: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h} ${period}`;
}
