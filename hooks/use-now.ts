"use client";

import { useEffect, useState } from "react";

/** Attendance displays need at most one update per minute. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Date.now()),
      Math.max(60_000, intervalMs),
    );
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
