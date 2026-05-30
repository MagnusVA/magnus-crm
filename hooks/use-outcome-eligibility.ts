"use client";

import { useEffect, useState } from "react";
import type { Doc } from "@/convex/_generated/dataModel";

const OUTCOME_LEAD_MS = 5 * 60_000;
const TICK_INTERVAL_MS = 15_000;

export function useOutcomeEligibility(meeting: Doc<"meetings">): boolean {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(
      () => setNow(Date.now()),
      TICK_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, []);

  return meeting.status === "scheduled" && now >= meeting.scheduledAt - OUTCOME_LEAD_MS;
}
