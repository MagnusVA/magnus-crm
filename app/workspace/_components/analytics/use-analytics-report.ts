"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { api } from "@/convex/_generated/api";
import type { AnalyticsRangePlan } from "@/lib/analyticsRange";
import { reportClientError } from "@/lib/observability/report-client-error";

export type AnalyticsPage = NonNullable<
  FunctionReturnType<typeof api.tenants.getCurrentTenant>
>["analyticsReports"][number];

export type AnalyticsSource = "live" | "warehouse" | "loading";

type AnalyticsFilterInput = Record<string, string | number | boolean | null | undefined>;

type WarehouseState = "loading" | "queued" | "pending" | "ready" | "failed";

export type AnalyticsFreshness =
  | { source: "live" }
  | {
      source: "warehouse";
      state: WarehouseState;
      /** The sync the shown numbers come from. */
      asOf: number | null;
      /** An older answer is shown while the current sync's runs. */
      refreshing: boolean;
      /** ClickHouse answers the days before today, and today is read live. */
      liveToday: boolean;
      errorMessage: string | null;
      retry: () => void;
    };

/**
 * Which source answers a page's range (docs/agents/reporting.md): a range that
 * starts today reads Convex live. Any other range reads ClickHouse, for its
 * days before today, once the page is switched for the tenant, or with
 * `?analytics=preview` in the URL; until then the page's Convex readers answer.
 */
export function useAnalyticsSource(
  page: AnalyticsPage,
  plan: AnalyticsRangePlan,
): AnalyticsSource {
  const tenant = useQuery(api.tenants.getCurrentTenant, {});
  const preview = useSearchParams().get("analytics") === "preview";
  if (plan.kind === "live") return "live";
  if (preview) return "warehouse";
  if (tenant === undefined) return "loading";
  return tenant?.analyticsReports.includes(page) ? "warehouse" : "live";
}

function cleanFilters(filters: AnalyticsFilterInput | undefined) {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const RENEW_INTERVAL_MS = 60 * 60 * 1000;
const RESEND_AFTER_MS = 60 * 1000;

/**
 * One panel's data from whichever source answers its range. The ClickHouse
 * answer has exactly the shape the Convex reader returns, so the panel
 * doesn't change. A range that covers days before today and today itself is
 * split: ClickHouse answers the days before today, the reader answers the rest
 * live (`todayArgs`), and `merge` joins the two into what the reader would
 * return for the whole range. Pass `liveArgs: "skip"` when the panel has
 * nothing to load.
 */
export function useAnalyticsReport<Query extends FunctionReference<"query">>(options: {
  page: AnalyticsPage;
  reportId: string;
  plan: AnalyticsRangePlan;
  filters?: AnalyticsFilterInput;
  live: Query;
  /** The reader's arguments for the whole range. */
  liveArgs: FunctionArgs<Query> | "skip";
  /** The reader's arguments from the start of today to the end of the range. */
  todayArgs: FunctionArgs<Query> | "skip";
  merge: (
    history: FunctionReturnType<Query>,
    today: FunctionReturnType<Query>,
  ) => FunctionReturnType<Query>;
}): { data: FunctionReturnType<Query> | undefined; source: AnalyticsSource; freshness: AnalyticsFreshness } {
  const { plan } = options;
  const source = useAnalyticsSource(options.page, plan);
  const skipped = options.liveArgs === "skip";
  const split = source === "warehouse" && plan.kind === "split";
  const liveArgs = source === "live" ? options.liveArgs : split && !skipped ? options.todayArgs : "skip";
  const liveData = useQuery(options.live, ...([liveArgs] as [FunctionArgs<Query> | "skip"]));

  const warehouseRange =
    source !== "warehouse" || skipped
      ? null
      : plan.kind === "split"
        ? plan.history
        : plan.kind === "warehouse"
          ? plan.range
          : null;
  const filtersKey = JSON.stringify(cleanFilters(options.filters));
  const rangeKey = warehouseRange ? JSON.stringify(warehouseRange) : null;
  const warehouseArgs = useMemo(
    () =>
      rangeKey !== null
        ? {
            reportId: options.reportId,
            filters: JSON.parse(filtersKey) as Record<string, string | number | boolean | null>,
            range: JSON.parse(rangeKey) as NonNullable<typeof warehouseRange>,
            timeZone: browserTimeZone(),
          }
        : null,
    [rangeKey, options.reportId, filtersKey],
  );
  const state = useQuery(api.analytics.reports.get, warehouseArgs ?? "skip");
  const request = useMutation(api.analytics.reports.request);
  const requestedKey = useRef<string | null>(null);
  // A split's history keeps its preset key from day to day, so the key a
  // panel requests includes the days it needs: the request goes out again
  // when today moves on, and runs if the answer no longer covers them.
  const historyDays = plan.kind === "split" ? `${plan.historyStartDate}/${plan.historyEndDate}` : "";
  const argsKey = warehouseArgs ? `${JSON.stringify(warehouseArgs)}${historyDays}` : null;

  const send = useCallback(() => {
    if (!warehouseArgs) return;
    request(warehouseArgs).catch((error: unknown) =>
      reportClientError(error, { flow: "analytics_report_request", reportId: warehouseArgs.reportId }),
    );
  }, [request, warehouseArgs]);

  const lastSentAt = useRef(0);

  // Registers the key for the post-sync batch and starts a run when no answer
  // covers the current sync. Once per key per mounted panel.
  useEffect(() => {
    if (argsKey === null || requestedKey.current === argsKey) return;
    requestedKey.current = argsKey;
    lastSentAt.current = Date.now();
    send();
  }, [argsKey, send]);

  // A panel left open keeps its key in the batch (which refreshes keys
  // opened in the last 7 days) by renewing it hourly.
  useEffect(() => {
    if (argsKey === null) return;
    const timer = setInterval(send, RENEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [argsKey, send]);

  // Cleanup deletes keys nobody opened for 14 days; register it again, at
  // most once a minute.
  const answerState = state?.state;
  useEffect(() => {
    if (answerState !== "missing" || argsKey === null || requestedKey.current !== argsKey) return;
    const now = Date.now();
    if (now - lastSentAt.current < RESEND_AFTER_MS) return;
    lastSentAt.current = now;
    send();
  }, [answerState, argsKey, send]);

  // A split merges only an answer for exactly the days before today. Last
  // night's answer for "this week through yesterday" misses yesterday, so
  // it waits for the run the request above starts.
  const answer = state?.answer ?? null;
  const answerFits =
    plan.kind !== "split" ||
    (answer !== null &&
      answer.startDate === plan.historyStartDate &&
      answer.endDateInclusive === plan.historyEndDate);
  const payloadJson = answerFits ? (state?.payloadJson ?? null) : null;
  const warehouseData = useMemo(
    () => (payloadJson === null ? undefined : (JSON.parse(payloadJson) as FunctionReturnType<Query>)),
    [payloadJson],
  );
  const { merge } = options;
  const mergedData = useMemo(
    () =>
      split && warehouseData !== undefined && liveData !== undefined
        ? merge(warehouseData, liveData)
        : undefined,
    [split, warehouseData, liveData, merge],
  );

  if (source !== "warehouse") {
    return { data: source === "live" ? liveData : undefined, source, freshness: { source: "live" } };
  }
  // A skipped panel loads nothing, so it has no freshness to report.
  if (skipped) return { data: undefined, source, freshness: { source: "live" } };
  let shownState: WarehouseState = answerState === undefined || answerState === "missing" ? "loading" : answerState;
  if (shownState === "ready" && payloadJson === null) shownState = "loading";
  return {
    data: split ? mergedData : warehouseData,
    source,
    freshness: {
      source: "warehouse",
      state: shownState,
      asOf: answerFits ? (answer?.watermark ?? null) : null,
      refreshing: shownState === "pending" && payloadJson !== null,
      liveToday: split,
      errorMessage: state?.errorMessage ?? null,
      retry: send,
    },
  };
}
