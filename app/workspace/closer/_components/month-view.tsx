"use client";

import { useMemo } from "react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isToday,
} from "date-fns";
import { cn } from "@/lib/utils";

import type { EnrichedMeeting } from "./calendar-utils";
import { MeetingPill } from "./meeting-block";

type MonthViewProps = {
  meetings: EnrichedMeeting[];
  month: Date;
};

// ─── Hoisted constants ───────────────────────────────────────────────────────

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Maximum meeting dots shown per cell before collapsing to a "+N" badge. */
const MAX_DOTS = 3;

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Month‑view calendar grid.
 *
 * Each day cell shows compact meeting pills (up to 3) and a "+N" overflow
 * badge when there are more. Clicking a pill opens the meeting detail dialog.
 */
export function MonthView({ meetings, month }: MonthViewProps) {
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(month);
    const monthEnd = endOfMonth(month);
    return eachDayOfInterval({
      start: startOfWeek(monthStart),
      end: endOfWeek(monthEnd),
    });
  }, [month]);

  // Build a Map<dateKey, meetings[]> for O(1) per‑cell lookups
  const meetingsByDate = useMemo(() => {
    const map = new Map<string, EnrichedMeeting[]>();
    for (const m of meetings) {
      const key = format(new Date(m.meeting.scheduledAt), "yyyy-MM-dd");
      const list = map.get(key) ?? [];
      list.push(m);
      map.set(key, list);
    }
    return map;
  }, [meetings]);

  return (
    <div className="rounded-lg border">
      {/* Day‑of‑week header */}
      <div className="grid grid-cols-7 border-b bg-muted/30">
        {DAY_LABELS.map((label) => (
          <div
            key={label}
            className="py-2 text-center text-[11px] font-medium uppercase text-muted-foreground"
          >
            {label}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {calendarDays.map((day) => {
          const key = format(day, "yyyy-MM-dd");
          const dayMeetings = meetingsByDate.get(key) ?? [];
          const inMonth = isSameMonth(day, month);
          const today = isToday(day);

          return (
            <div
              key={key}
              className={cn(
                "relative flex min-h-[80px] flex-col gap-1 border-b border-r border-border/40 p-1.5 last:border-r-0 [&:nth-child(7n)]:border-r-0",
                !inMonth && "bg-muted/20",
                today && "bg-primary/5",
              )}
              aria-label={`${format(day, "EEEE, MMMM d")}${dayMeetings.length > 0 ? `, ${dayMeetings.length} meeting${dayMeetings.length > 1 ? "s" : ""}` : ""}`}
            >
              {/* Day number */}
              <span
                className={cn(
                  "flex size-6 items-center justify-center self-end rounded-full text-xs tabular-nums",
                  !inMonth && "text-muted-foreground/50",
                  today &&
                    "bg-primary text-primary-foreground font-medium",
                )}
              >
                {format(day, "d")}
              </span>

              {/* Meeting dots / pills */}
              <div className="flex flex-col gap-0.5">
                {dayMeetings.slice(0, MAX_DOTS).map((m) => {
                  return (
                    <MeetingPill
                      key={m.meeting._id}
                      meetingId={m.meeting._id}
                      scheduledAt={m.meeting.scheduledAt}
                      durationMinutes={m.meeting.durationMinutes}
                      status={m.meeting.status}
                      leadName={m.leadName}
                      eventTypeName={m.eventTypeName}
                      meetingJoinUrl={m.meeting.meetingJoinUrl}
                      zoomJoinUrl={m.meeting.zoomJoinUrl}
                    />
                  );
                })}

                {dayMeetings.length > MAX_DOTS && (
                  <span className="px-1 text-[10px] font-medium text-muted-foreground">
                    +{dayMeetings.length - MAX_DOTS} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
