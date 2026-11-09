"use client";

import { useEffect, useRef, useState } from "react";
import posthog from "@/lib/posthog-browser";
import { isPostHogEnabled } from "@/lib/posthog-config";

// Small hooks the Calls and People pages share. The shared analytics hook
// (`use-report-analytics.ts`) names only the old report pages, so these pages
// send the same `report_viewed` event from here instead of editing it.

/**
 * A section's data kept on screen while new arguments load (DESIGN.md, Kept
 * Data While Reloading). `key` names what the data is for (the range and
 * filters): the section dims only when the key changed, so a minute clock in
 * the arguments refreshes the numbers without dimming them every minute.
 */
export function useKept<T>(value: T | undefined, key: string, phrase: string) {
  const [kept, setKept] = useState<{ value: T; key: string; phrase: string } | undefined>(
    value === undefined ? undefined : { value, key, phrase },
  );
  if (value !== undefined && (kept === undefined || kept.value !== value || kept.key !== key || kept.phrase !== phrase)) {
    setKept({ value, key, phrase });
  }
  return {
    data: value ?? kept?.value,
    phrase: value === undefined && kept ? kept.phrase : phrase,
    reloading: value === undefined && kept !== undefined && kept.key !== key,
  };
}

export type RebuiltReport = "calls" | "people" | "member";

/** Sends `report_viewed` once per mounted page. */
export function useReportViewed(report: RebuiltReport) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || !isPostHogEnabled()) return;
    sent.current = true;
    posthog.capture("report_viewed", { report });
  }, [report]);
}

/** Sends `report_filters_changed` with what the page's filters now hold. */
export function captureReportFilters(report: RebuiltReport, properties: Record<string, string | boolean>) {
  if (!isPostHogEnabled()) return;
  posthog.capture("report_filters_changed", { report, ...properties });
}
