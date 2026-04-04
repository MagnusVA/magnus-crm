"use client";

import { useMemo } from "react";
import { isSameDay } from "date-fns";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MeetingBlock } from "./meeting-block";
import {
  type EnrichedMeeting,
  HOURS,
  HOUR_HEIGHT,
  START_HOUR,
  END_HOUR,
  getTopPx,
  getHeightPx,
  formatHour,
  useCurrentTime,
} from "./calendar-utils";

type DayViewProps = {
  meetings: EnrichedMeeting[];
  date: Date;
};

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Single‑day calendar view with an hourly time gutter on the left and meeting
 * blocks positioned absolutely.
 */
// ─── Now indicator component ────────────────────────────────────────────

function NowIndicator({ now }: { now: Date }) {
  const hour = now.getHours();
  const minutes = now.getMinutes();

  // Only show if within the visible grid range
  if (hour < START_HOUR || hour >= END_HOUR) return null;

  const topPx = (hour - START_HOUR) * HOUR_HEIGHT + (minutes / 60) * HOUR_HEIGHT;

  return (
    <div
      className="pointer-events-none absolute left-0 right-0 z-10 flex items-center"
      style={{ top: `${topPx}px` }}
      aria-hidden="true"
    >
      <div className="size-2 rounded-full bg-red-500" />
      <div className="h-px flex-1 bg-red-500" />
    </div>
  );
}

export function DayView({ meetings, date }: DayViewProps) {
  const dayMeetings = useMemo(
    () =>
      meetings.filter((m) => isSameDay(new Date(m.meeting.scheduledAt), date)),
    [meetings, date],
  );

  const totalHeight = HOURS.length * HOUR_HEIGHT;
  const now = useCurrentTime();

  return (
    <ScrollArea className="h-[calc(100dvh-20rem)] min-h-[400px] rounded-lg border">
      <div className="flex" style={{ height: totalHeight }}>
        {/* Time gutter */}
        <div className="w-16 shrink-0 border-r" aria-hidden="true">
          {HOURS.map((hour) => (
            <div
              key={hour}
              className="flex h-[60px] items-start justify-end border-b border-border/40 pr-2 pt-1 text-[11px] tabular-nums text-muted-foreground"
            >
              {formatHour(hour)}
            </div>
          ))}
        </div>

        {/* Day column */}
        <div className="relative flex-1">
          {/* Hour grid lines */}
          {HOURS.map((hour) => (
            <div key={hour} className="h-[60px] border-b border-border/40" />
          ))}

          {/* Meetings */}
          {dayMeetings.map((m) => (
            <MeetingBlock
              key={m.meeting._id}
              meetingId={m.meeting._id}
              scheduledAt={m.meeting.scheduledAt}
              durationMinutes={m.meeting.durationMinutes}
              status={m.meeting.status}
              leadName={m.leadName}
              eventTypeName={m.eventTypeName}
              style={{
                top: getTopPx(m.meeting.scheduledAt),
                height: getHeightPx(m.meeting.durationMinutes),
              }}
            />
          ))}

          {/* Current time indicator */}
          {isSameDay(now, date) && <NowIndicator now={now} />}
        </div>
      </div>
    </ScrollArea>
  );
}

