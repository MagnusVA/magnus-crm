"use client";

import { useMemo } from "react";
import { isSameDay } from "date-fns";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MeetingBlock } from "./meeting-block";
import {
  type EnrichedMeeting,
  HOURS,
  HOUR_HEIGHT,
  getTopPx,
  getHeightPx,
  formatHour,
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
export function DayView({ meetings, date }: DayViewProps) {
  const dayMeetings = useMemo(
    () =>
      meetings.filter((m) => isSameDay(new Date(m.meeting.scheduledAt), date)),
    [meetings, date],
  );

  const totalHeight = HOURS.length * HOUR_HEIGHT;

  return (
    <ScrollArea className="h-[600px] rounded-lg border">
      <div className="flex" style={{ height: totalHeight }}>
        {/* Time gutter */}
        <div className="w-16 shrink-0 border-r">
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
        </div>
      </div>
    </ScrollArea>
  );
}

