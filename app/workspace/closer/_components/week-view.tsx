"use client";

import { useMemo } from "react";
import { format, addDays, isSameDay, isToday } from "date-fns";
import { cn } from "@/lib/utils";
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

type WeekViewProps = {
  meetings: EnrichedMeeting[];
  /** The start‑of‑week date (usually Sunday). */
  startDate: Date;
};

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * 7‑column week view.
 *
 * Columns represent days (Sun → Sat). Each column has hourly rows (7 AM – 9 PM)
 * with meeting blocks positioned absolutely based on `scheduledAt` and
 * `durationMinutes`.
 *
 * Today's column gets a subtle highlight for quick orientation.
 */
// ─── Now indicator component ────────────────────────────────────────────

function NowIndicator({ now, todayColumnIndex }: { now: Date; todayColumnIndex: number }) {
  const hour = now.getHours();
  const minutes = now.getMinutes();

  // Only show if within the visible grid range
  if (hour < START_HOUR || hour >= END_HOUR) return null;

  const topPx = (hour - START_HOUR) * HOUR_HEIGHT + (minutes / 60) * HOUR_HEIGHT;
  const leftOffset = `calc(4rem + ${todayColumnIndex} * (1fr))`;

  return (
    <div
      className="pointer-events-none absolute left-0 right-0 z-10 flex items-center"
      style={{
        top: `${topPx}px`,
        gridColumn: todayColumnIndex + 2, // +2 for time gutter + day offset
      }}
      aria-hidden="true"
    >
      <div className="size-2 rounded-full bg-red-500" />
      <div className="h-px flex-1 bg-red-500" />
    </div>
  );
}

export function WeekView({ meetings, startDate }: WeekViewProps) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(startDate, i)),
    [startDate],
  );

  // Build a Map<dayIndex, meeting[]> for O(1) lookups
  // (js-index-maps)
  const meetingsByDay = useMemo(() => {
    const map = new Map<number, EnrichedMeeting[]>();
    for (const m of meetings) {
      const mDate = new Date(m.meeting.scheduledAt);
      const dayIdx = days.findIndex((d) => isSameDay(d, mDate));
      if (dayIdx === -1) continue;
      const list = map.get(dayIdx) ?? [];
      list.push(m);
      map.set(dayIdx, list);
    }
    return map;
  }, [meetings, days]);

  const totalHeight = HOURS.length * HOUR_HEIGHT;
  const now = useCurrentTime();
  const todayColumnIndex = days.findIndex((d) => isToday(d));

  return (
    <ScrollArea className="h-[calc(100dvh-20rem)] min-h-[400px] rounded-lg border">
      <div className="min-w-[700px]">
        {/* ── Day headers ── */}
        <div className="sticky top-0 z-10 grid grid-cols-[4rem_repeat(7,1fr)] border-b bg-background">
          <div className="border-r border-border/40" />
          {days.map((day) => {
            const today = isToday(day);
            return (
              <div
                key={day.toISOString()}
                className={cn(
                  "flex flex-col items-center gap-0.5 border-r border-border/40 py-2 text-center last:border-r-0",
                  today && "bg-primary/5",
                )}
              >
                <span className="text-[11px] font-medium uppercase text-muted-foreground">
                  {format(day, "EEE")}
                </span>
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full text-sm tabular-nums",
                    today && "bg-primary text-primary-foreground font-medium",
                  )}
                >
                  {format(day, "d")}
                </span>
              </div>
            );
          })}
        </div>

        {/* ── Time grid ── */}
        <div
          className="grid grid-cols-[4rem_repeat(7,1fr)]"
          style={{ height: totalHeight, position: "relative" }}
        >
          {/* Time gutter */}
          <div className="border-r border-border/40" aria-hidden="true">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="flex h-[60px] items-start justify-end border-b border-border/40 pr-2 pt-1 text-[11px] tabular-nums text-muted-foreground"
              >
                {formatHour(hour)}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day, dayIdx) => {
            const dayMeetings = meetingsByDay.get(dayIdx) ?? [];
            const today = isToday(day);

            return (
              <div
                key={day.toISOString()}
                className={cn(
                  "relative border-r border-border/40 last:border-r-0",
                  today && "bg-primary/[0.02]",
                )}
              >
                {/* Hour grid lines */}
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="h-[60px] border-b border-border/40"
                  />
                ))}

                {/* Meeting blocks */}
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

                {/* Current time indicator for today's column */}
                {today && <NowIndicator now={now} todayColumnIndex={dayIdx} />}
              </div>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}
