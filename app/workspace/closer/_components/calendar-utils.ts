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

// ─── Overlap layout ─────────────────────────────────────────────────────────

/** Meeting augmented with overlap-column metadata. */
export type PositionedMeeting = EnrichedMeeting & {
  /** 0-based column index within this meeting's overlap cluster. */
  column: number;
  /** Total number of columns used by this meeting's overlap cluster. */
  columnCount: number;
};

/**
 * Assign side-by-side columns to overlapping meetings so they all remain
 * legible — matches the behaviour of Google Calendar / Apple Calendar.
 *
 * 1. Sort by start time; longer events first on ties so they land in the
 *    leftmost column (more visually prominent).
 * 2. Walk the sorted list and group into clusters — a cluster is a maximal
 *    run of events where each subsequent event starts before the cluster's
 *    running end time.
 * 3. Within a cluster, greedily assign each event to the first column whose
 *    previous event ended at/before this one starts; otherwise open a new
 *    column. The cluster's column count is the total columns used.
 *
 * Non-overlapping events end up in 1-event clusters with `columnCount === 1`
 * and render full-width.
 */
export function layoutMeetings(
  meetings: EnrichedMeeting[],
): PositionedMeeting[] {
  if (meetings.length === 0) return [];

  const sorted = [...meetings].sort((a, b) => {
    const startDiff = a.meeting.scheduledAt - b.meeting.scheduledAt;
    if (startDiff !== 0) return startDiff;
    return b.meeting.durationMinutes - a.meeting.durationMinutes;
  });

  const endMs = (m: EnrichedMeeting) =>
    m.meeting.scheduledAt + m.meeting.durationMinutes * 60_000;

  const result: PositionedMeeting[] = [];
  let clusterStart = 0;
  let clusterColumns: number[] = []; // per-column end timestamp
  let clusterAssignments: number[] = []; // per-item column index
  let clusterEnd = 0; // max end across the current cluster

  const flush = () => {
    const columnCount = clusterColumns.length;
    for (let k = 0; k < clusterAssignments.length; k++) {
      result.push({
        ...sorted[clusterStart + k],
        column: clusterAssignments[k],
        columnCount,
      });
    }
    clusterColumns = [];
    clusterAssignments = [];
    clusterEnd = 0;
  };

  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    const start = m.meeting.scheduledAt;
    const end = endMs(m);

    // Close the current cluster when this event starts after everything in it
    if (clusterAssignments.length > 0 && start >= clusterEnd) {
      flush();
      clusterStart = i;
    }

    // First column whose previous event ended at/before this one starts, else new
    let col = clusterColumns.findIndex((prevEnd) => prevEnd <= start);
    if (col === -1) {
      col = clusterColumns.length;
      clusterColumns.push(end);
    } else {
      clusterColumns[col] = end;
    }
    clusterAssignments.push(col);
    if (end > clusterEnd) clusterEnd = end;
  }

  if (clusterAssignments.length > 0) flush();

  return result;
}

/**
 * Left/width CSS for a meeting block based on its column layout.
 *
 * Divides the day column into `columnCount` equal-width slots with a 2 px
 * gutter on each side (4 px gap between adjacent columns). When a block is
 * alone in its cluster (`columnCount === 1`) this approximates the previous
 * `inset-x-1` full-width behaviour.
 */
export function getBlockHorizontalStyle(column: number, columnCount: number) {
  const widthPct = 100 / columnCount;
  return {
    left: `calc(${widthPct * column}% + 2px)`,
    width: `calc(${widthPct}% - 4px)`,
  };
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
