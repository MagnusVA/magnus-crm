"use client";

import { useCallback, useRef } from "react";
import posthog from "posthog-js";
import { isPostHogEnabled } from "@/lib/posthog-config";

type ReportName =
  | "pipeline_health"
  | "team_performance"
  | "revenue"
  | "slack_qualifications"
  | "booked_vs_sold";

type DateRangePreset = "7d" | "30d" | "month" | "custom";

type ReportFilterProperties = {
  date_range_preset: DateRangePreset;
  has_booking_program_filter?: boolean;
  has_sold_program_filter?: boolean;
  has_payment_program_filter?: boolean;
  has_attribution_team_filter?: boolean;
  has_dm_closer_filter?: boolean;
  has_slack_setter_filter?: boolean;
  has_payment_type_filter?: boolean;
  has_revenue_slice_filter?: boolean;
};

export function useReportAnalytics(report: ReportName) {
  const viewedRef = useRef(false);

  const captureViewed = useCallback(() => {
    if (!isPostHogEnabled() || viewedRef.current) {
      return;
    }
    posthog.capture("report_viewed", { report });
    viewedRef.current = true;
  }, [report]);

  const captureFiltersChanged = useCallback(
    (properties: ReportFilterProperties) => {
      if (!isPostHogEnabled()) {
        return;
      }
      posthog.capture("report_filters_changed", {
        report,
        ...properties,
      });
    },
    [report],
  );

  return { captureViewed, captureFiltersChanged };
}
