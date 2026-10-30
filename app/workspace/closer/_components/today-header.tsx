"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useBusinessDay } from "@/hooks/use-business-day";
import {
  BUSINESS_DAY_REBUILD_MESSAGE,
  businessDateForInstant,
  businessDayHourLabel,
  type BusinessDaySetting,
} from "@/lib/businessDay";
import { boardRange, formatBusinessDate, formatClock } from "./today-time";

/** A clock that ticks on the minute, not a minute after the page opened. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);
  return now;
}

/** "Today", the business date and how the day is counted, the clock, and today's calls. */
export function TodayHeader({ setting }: { setting: BusinessDaySetting }) {
  const now = useMinuteClock();
  const { rebuilding } = useBusinessDay();
  const today = businessDateForInstant(now, setting);
  const range = useMemo(() => boardRange("today", today, setting), [today, setting]);
  // The board's own Today query (same arguments), so this adds no read.
  const calls = useQuery(api.closer.calendar.getMeetingsForRange, {
    startDate: range.start,
    endDate: range.end,
  });
  const hour = businessDayHourLabel(setting);
  const caption = calls && !calls.isPartial ? callsCaption(calls.meetings) : null;

  return (
    <header className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-1">
      <h1 className="text-[26px] leading-[1.1] font-semibold tracking-[-0.01em]">Today</h1>
      <time
        dateTime={new Date(now).toISOString()}
        className="text-right font-condensed text-[26px] leading-[1.1] font-semibold tabular-nums"
      >
        {formatClock(now, setting.timeZone)}
      </time>
      <p className="min-w-0 text-[13px] text-muted-foreground">
        {formatBusinessDate(today)} · Days run {hour}–{hour}, {setting.timeZone}
      </p>
      <p className="text-right text-[13px] text-muted-foreground tabular-nums">{caption}</p>
      {rebuilding ? (
        <p role="status" className="col-span-2 text-[13px] text-muted-foreground">
          {BUSINESS_DAY_REBUILD_MESSAGE}
        </p>
      ) : null}
    </header>
  );
}

/**
 * "3 of 5 calls held" once a call is held, "5 calls today" before. Canceled
 * calls aren't counted, as on the board's summary.
 */
function callsCaption(meetings: Array<{ meeting: { status: string } }>) {
  const live = meetings.filter(({ meeting }) => meeting.status !== "canceled");
  if (live.length === 0) return null;
  const held = live.filter(({ meeting }) => meeting.status === "held").length;
  const calls = live.length === 1 ? "call" : "calls";
  return held > 0 ? `${held} of ${live.length} ${calls} held` : `${live.length} ${calls} today`;
}
