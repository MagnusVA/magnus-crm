"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { api } from "@/convex/_generated/api";
import type { AnalyticsRange } from "@/lib/analyticsRange";
import { reportClientError } from "@/lib/observability/report-client-error";

export type AnalyticsPage = NonNullable<
  FunctionReturnType<typeof api.tenants.getCurrentTenant>
>["analyticsReports"][number];

export type AnalyticsSource = "live" | "warehouse" | "loading";

type AnalyticsFilterInput = Record<string, string | number | boolean | null | undefined>;

export type AnalyticsFreshness =
  | { source: "live" }
  | {
      source: "warehouse";
      state: "loading" | "queued" | "pending" | "ready" | "failed";
      /** The sync the shown numbers come from. */
      asOf: number | null;
      /** An older answer is shown while the current sync's runs. */
      refreshing: boolean;
      errorMessage: string | null;
      retry: () => void;
    };

/**
 * Which source answers a page's range (docs/plans/clickhouse-reporting.md §4):
 * Today always reads Convex live (`range` is null). Any other range reads
 * ClickHouse once the page is switched for the tenant, or with
 * `?analytics=preview` in the URL; until then the page's Convex readers answer.
 */
export function useAnalyticsSource(
  page: AnalyticsPage,
  range: AnalyticsRange | null,
): AnalyticsSource {
  const tenant = useQuery(api.tenants.getCurrentTenant, {});
  const preview = useSearchParams().get("analytics") === "preview";
  if (range === null) return "live";
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

/**
 * One panel's data from whichever source answers its range. The ClickHouse
 * answer has exactly the shape the Convex reader returns, so the panel
 * doesn't change. Pass `liveArgs: "skip"` when the panel has nothing to load.
 */
export function useAnalyticsReport<Query extends FunctionReference<"query">>(options: {
  page: AnalyticsPage;
  reportId: string;
  range: AnalyticsRange | null;
  filters?: AnalyticsFilterInput;
  live: Query;
  liveArgs: FunctionArgs<Query> | "skip";
}): { data: FunctionReturnType<Query> | undefined; source: AnalyticsSource; freshness: AnalyticsFreshness } {
  const source = useAnalyticsSource(options.page, options.range);
  const skipped = options.liveArgs === "skip";
  const liveData = useQuery(
    options.live,
    ...([source === "live" ? options.liveArgs : "skip"] as [FunctionArgs<Query> | "skip"]),
  );

  const filtersKey = JSON.stringify(cleanFilters(options.filters));
  const rangeKey = options.range ? JSON.stringify(options.range) : null;
  const warehouseArgs = useMemo(
    () =>
      source === "warehouse" && rangeKey !== null && !skipped
        ? {
            reportId: options.reportId,
            filters: JSON.parse(filtersKey) as Record<string, string | number | boolean | null>,
            range: JSON.parse(rangeKey) as AnalyticsRange,
            timeZone: browserTimeZone(),
          }
        : null,
    [source, rangeKey, skipped, options.reportId, filtersKey],
  );
  const state = useQuery(api.analytics.reports.get, warehouseArgs ?? "skip");
  const request = useMutation(api.analytics.reports.request);
  const requestedKey = useRef<string | null>(null);
  const argsKey = warehouseArgs ? JSON.stringify(warehouseArgs) : null;

  const send = useCallback(() => {
    if (!warehouseArgs) return;
    request(warehouseArgs).catch((error: unknown) =>
      reportClientError(error, { flow: "analytics_report_request", reportId: warehouseArgs.reportId }),
    );
  }, [request, warehouseArgs]);

  // Registers the key for the post-sync batch and starts a run when no answer
  // covers the current sync. Once per key per mounted panel.
  useEffect(() => {
    if (argsKey === null || requestedKey.current === argsKey) return;
    requestedKey.current = argsKey;
    send();
  }, [argsKey, send]);

  const payloadJson = state?.payloadJson ?? null;
  const warehouseData = useMemo(
    () => (payloadJson === null ? undefined : (JSON.parse(payloadJson) as FunctionReturnType<Query>)),
    [payloadJson],
  );

  if (source !== "warehouse") {
    return { data: source === "live" ? liveData : undefined, source, freshness: { source: "live" } };
  }
  const answerState = state === undefined || state.state === "missing" ? "loading" : state.state;
  return {
    data: warehouseData,
    source,
    freshness: {
      source: "warehouse",
      state: answerState,
      asOf: state?.answer?.watermark ?? null,
      refreshing: answerState === "pending" && payloadJson !== null,
      errorMessage: state?.errorMessage ?? null,
      retry: send,
    },
  };
}
