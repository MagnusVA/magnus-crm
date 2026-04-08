"use client";

import { useReportWebVitals } from "next/web-vitals";

/**
 * Reports Core Web Vitals to the console during development.
 * Extend with PostHog/analytics capture in production.
 *
 * Metrics reported:
 * - FCP  (First Contentful Paint)
 * - LCP  (Largest Contentful Paint)
 * - CLS  (Cumulative Layout Shift)
 * - INP  (Interaction to Next Paint)
 * - TTFB (Time to First Byte)
 *
 * Renders null — side-effect-only component with no DOM output.
 * Placed outside Suspense in the workspace layout so it's always
 * mounted and reports metrics regardless of auth state.
 *
 * @see vercel-react-best-practices — performance monitoring
 */
export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    // Development: log to console
    console.debug(
      `[WebVitals] ${metric.name}: ${metric.value.toFixed(1)}${metric.name === "CLS" ? "" : "ms"}`,
    );

    // Production: send to analytics
    // Example: posthog.capture("web_vital", { metric_name: metric.name, value: metric.value });
  });

  return null;
}
