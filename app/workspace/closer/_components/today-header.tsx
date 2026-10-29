"use client";

import { useEffect, useState } from "react";
import { DayDefinition } from "@/app/workspace/_components/day-definition";
import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { formatBusinessDate, formatClock } from "./today-time";

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

/** "Today", the business date, how the day is counted, and the clock. */
export function TodayHeader({ setting }: { setting: BusinessDaySetting }) {
  const now = useMinuteClock();
  const today = businessDateForInstant(now, setting);

  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-[1.1] font-semibold tracking-[-0.01em]">Today</h1>
        <p className="mt-1 text-sm text-muted-foreground">{formatBusinessDate(today)}</p>
        <DayDefinition />
      </div>
      <p className="text-right">
        <time
          dateTime={new Date(now).toISOString()}
          className="block font-condensed text-[26px] leading-none font-semibold tabular-nums"
        >
          {formatClock(now, setting.timeZone)}
        </time>
      </p>
    </header>
  );
}
