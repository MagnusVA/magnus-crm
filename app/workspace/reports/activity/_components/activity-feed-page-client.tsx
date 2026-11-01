"use client";

import type { FunctionArgs } from "convex/server";
import { useEffect, useRef, useState } from "react";
// The feed pages a stream, so it needs the helper's hook, which pins each
// loaded page's end cursor; Convex's own hook doesn't for stream pagination.
import { usePaginatedQuery } from "convex-helpers/react";
import { addDays, startOfDay } from "date-fns";
import { AlertTriangleIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { reportRangePlan, reportWindowFromToday } from "@/lib/analyticsRange";
import { mergeActivitySummary } from "@/convex/analytics/merge/activity";
import { AnalyticsFreshnessLine } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ReportDateControls,
  type DateRange,
} from "@/app/workspace/reports/_components/report-date-controls";
import type { PaymentType } from "@/app/workspace/reports/_components/report-payment-type-filter";
import { ActivityFeedSkeleton } from "./activity-feed-skeleton";
import { ActivitySummaryCards } from "./activity-summary-cards";
import { ActivityFeedFilters } from "./activity-feed-filters";
import { ActivityFeedList } from "./activity-feed-list";

type EntityType =
  | "customer"
  | "enrollment"
  | "followUp"
  | "lead"
  | "meeting"
  | "opportunity"
  | "payment"
  | "user";

interface Filters {
  entityType?: EntityType;
  eventType?: string;
  actorUserId?: string;
  programId?: Id<"tenantPrograms">;
  paymentType?: PaymentType;
}

export function ActivityFeedPageClient() {
  usePageTitle("Activity Feed");

  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const today = new Date();
    return {
      startDate: startOfDay(today).getTime(),
      endDate: startOfDay(addDays(today, 1)).getTime(),
    };
  });
  const [filters, setFilters] = useState<Filters>({});
  const resetKey = [
    dateRange.startDate,
    dateRange.endDate,
    filters.entityType ?? "",
    filters.eventType ?? "",
    filters.actorUserId ?? "",
    filters.programId ?? "",
    filters.paymentType ?? "",
  ].join("|");
  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md). The paged feed always reads Convex.
  const now = useNow();
  const summaryReport = useAnalyticsReport({
    page: "activity",
    reportId: "activity.summary",
    plan: reportRangePlan(dateRange, now),
    live: api.reporting.activityFeed.getActivitySummary,
    liveArgs: dateRange,
    todayArgs: reportWindowFromToday(dateRange, now),
    merge: mergeActivitySummary,
  });
  const summary = summaryReport.data;

  // Only include defined filter values in query args
  const feedArgs = {
    ...dateRange,
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.eventType ? { eventType: filters.eventType } : {}),
    ...(filters.actorUserId
      ? { actorUserId: filters.actorUserId as Id<"users"> }
      : {}),
    ...(filters.programId ? { programId: filters.programId } : {}),
    ...(filters.paymentType ? { paymentType: filters.paymentType } : {}),
  };

  // A ClickHouse range can take a while to load; keep the controls and its
  // status on screen instead of the full-page skeleton.
  if (summary === undefined && summaryReport.freshness.source === "live") {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Activity Feed
          </h1>
          <p className="text-sm text-muted-foreground">
            Audit trail of all CRM actions — who did what and when
          </p>
        </div>
        <ActivityFeedSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity Feed</h1>
        <p className="text-sm text-muted-foreground">
          Audit trail of all CRM actions — who did what and when
        </p>
      </div>

      {/* Date range controls */}
      <ReportDateControls value={dateRange} onChange={setDateRange} />
      <AnalyticsFreshnessLine items={[summaryReport.freshness]} />

      {/* Summary cards */}
      {summary !== undefined ? (
        <ActivitySummaryCards summary={summary} dateRange={dateRange} />
      ) : (
        <Skeleton className="h-44 rounded-lg" />
      )}

      {/* Truncation warning */}
      {summary?.isTruncated && (
        <Alert variant="destructive">
          <AlertTriangleIcon className="h-4 w-4" />
          <AlertDescription>
            Results are truncated. Narrow the date range to see all activity.
          </AlertDescription>
        </Alert>
      )}

      {/* Filters */}
      <ActivityFeedFilters
        filters={filters}
        onChange={setFilters}
        actorBreakdown={summary?.actorBreakdown ?? []}
      />

      {/* Event list */}
      <ActivityFeedResults key={resetKey} args={feedArgs} />
    </div>
  );
}

function ActivityFeedResults({
  args,
}: {
  args: Omit<
    FunctionArgs<typeof api.reporting.activityFeed.getActivityFeed>,
    "paginationOpts"
  >;
}) {
  const { results, status, loadMore, isLoading } = usePaginatedQuery(
    api.reporting.activityFeed.getActivityFeed,
    args,
    { initialNumItems: 50 },
  );
  // A filter the index can't apply (entity type, program, payment type) can
  // leave a page empty within its read budget. Keep reading, up to ten pages,
  // until a screenful of matches is in, so nobody clicks through empty pages.
  const argsKey = JSON.stringify(args);
  const autoLoads = useRef({ argsKey, count: 0 });
  useEffect(() => {
    if (autoLoads.current.argsKey !== argsKey) {
      autoLoads.current = { argsKey, count: 0 };
    }
    if (
      status === "CanLoadMore" &&
      results.length < 50 &&
      autoLoads.current.count < 10
    ) {
      autoLoads.current.count += 1;
      loadMore(50);
    }
  }, [argsKey, status, results.length, loadMore]);
  return (
    <ActivityFeedList
      events={results}
      onLoadMore={() => loadMore(50)}
      hasMore={status === "CanLoadMore" || status === "LoadingMore"}
      isLoading={isLoading}
    />
  );
}
