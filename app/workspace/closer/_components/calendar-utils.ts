"use client";

import { useEffect, useState } from "react";

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

// ─── Dynamic hour range ─────────────────────────────────────────────────────

/** Pixel height for a one-hour slot. */
export const HOUR_HEIGHT = 60;

/** Default range shown when no meetings exist (8 AM – 6 PM). */
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 18;

/** Computed visible hour range for the time grid. */
export type HourRange = {
  /** First visible hour (inclusive). */
  startHour: number;
  /** Last visible hour (exclusive). */
  endHour: number;
  /** Array of hour values to render (startHour … endHour - 1). */
  hours: number[];
};

/**
 * Compute the visible hour range from actual meeting data.
 *
 * Scans all meetings to find the earliest start and latest end, then adds
 * `padding` hours on each side. Clamps to [0, 24]. When no meetings exist
 * falls back to 8 AM – 6 PM.
 */
export function computeHourRange(
  meetings: EnrichedMeeting[],
  padding = 2,
): HourRange {
  if (meetings.length === 0) {
    return buildRange(DEFAULT_START_HOUR, DEFAULT_END_HOUR);
  }

  let minHour = 23;
  let maxHour = 0;

  for (const m of meetings) {
    const start = new Date(m.meeting.scheduledAt);
    const startH = start.getHours();

    // Compute end hour — use minute arithmetic to avoid midnight-crossing issues
    const startMinutes = startH * 60 + start.getMinutes();
    const endMinutes = startMinutes + m.meeting.durationMinutes;
    // Round up so a meeting ending at 10:15 PM → endH = 23
    const endH = Math.min(24, Math.ceil(endMinutes / 60));

    if (startH < minHour) minHour = startH;
    if (endH > maxHour) maxHour = endH;
  }

  const startHour = Math.max(0, minHour - padding);
  const endHour = Math.min(24, maxHour + padding);

  return buildRange(startHour, endHour);
}

function buildRange(startHour: number, endHour: number): HourRange {
  return {
    startHour,
    endHour,
    hours: Array.from(
      { length: endHour - startHour },
      (_, i) => startHour + i,
    ),
  };
}

// ─── Positioning helpers ────────────────────────────────────────────────────

/** Convert a scheduledAt timestamp to a top-offset in pixels within the time grid. */
export function getTopPx(scheduledAt: number, startHour: number): number {
  const d = new Date(scheduledAt);
  return (
    (d.getHours() - startHour) * HOUR_HEIGHT +
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

// ─── Current time hook ──────────────────────────────────────────────────

/**
 * Returns current time and re-renders every `intervalMs`.
 * Used for the "now" indicator line in day/week views.
 *
 * @param intervalMs Polling interval in milliseconds (default: 60_000 = 1 minute)
 * @returns Current Date object
 *
 * @example
 * const now = useCurrentTime();
 * // Re-renders every 60 seconds
 */
export function useCurrentTime(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
