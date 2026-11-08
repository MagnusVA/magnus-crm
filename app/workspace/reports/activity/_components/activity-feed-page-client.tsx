"use client";

import type { FunctionArgs } from "convex/server";
import { useEffect, useRef, useState } from "react";
// The feed pages a stream, so it needs the helper's hook, which pins each
// loaded page's end cursor; Convex's own hook doesn't for stream pagination.
import { usePaginatedQuery } from "convex-helpers/react";
import { addDays, startOfDay } from "date-fns";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { reportRangePlan, reportWindowFromToday } from "@/lib/analyticsRange";
import { mergeActivitySummary } from "@/convex/analytics/merge/activity";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import {
  ReportDateControls,
  reportDayLine,
  reportRangePhrase,
  reportRangeWords,
  type DateRange,
} from "@/app/workspace/reports/_components/report-date-controls";
import { REPORT_PAGE, ReportBand } from "@/app/workspace/reports/_components/report-ui";
import { ActivityFeedFilters, type ActivityFilters } from "./activity-feed-filters";
import { ActivityFeedList } from "./activity-feed-list";
import { ActivityBreakdown, ActivityFigures } from "./activity-summary";

const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

export function ActivityFeedPageClient() {
  usePageTitle("Activity Feed");
  const { setting } = useBusinessDay();

  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const today = new Date();
    return {
      startDate: startOfDay(today).getTime(),
      endDate: startOfDay(addDays(today, 1)).getTime(),
    };
  });
  const [filters, setFilters] = useState<ActivityFilters>({});
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
  // A new range keeps the last summary on screen, dimmed, with its own range.
  const kept = useKeptWhileLoading(summaryReport.data, reportRangePhrase(dateRange));
  const [keptRange, setKeptRange] = useState(dateRange);
  if (summaryReport.data !== undefined && keptRange !== dateRange) setKeptRange(dateRange);
  const shownRange = kept.reloading ? keptRange : dateRange;
  const summary = kept.data;
  const freshness = freshnessSummary([summaryReport.freshness], now);

  // Only include defined filter values in query args
  const feedArgs = {
    ...dateRange,
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.eventType ? { eventType: filters.eventType } : {}),
    ...(filters.actorUserId ? { actorUserId: filters.actorUserId as Id<"users"> } : {}),
    ...(filters.programId ? { programId: filters.programId } : {}),
    ...(filters.paymentType ? { paymentType: filters.paymentType } : {}),
  };
  const filtered = Object.keys(filters).length > 0;

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title="Activity feed"
        range={reportRangeWords(shownRange)}
        freshness={summaryReport.data !== undefined ? freshness : null}
        dayLine={reportDayLine("browser", setting)}
        actions={<ReportDateControls value={dateRange} onChange={setDateRange} />}
        figures={<ActivityFigures summary={summary} range={shownRange} rangePhrase={kept.phrase} reloading={kept.reloading} />}
        filters={
          <ActivityFeedFilters filters={filters} onChange={setFilters} actorBreakdown={summary?.actorBreakdown ?? []} />
        }
      />
      <AnalyticsFreshnessAlert summary={freshness} />

      <ActivityBreakdown summary={summary} rangePhrase={kept.phrase} reloading={kept.reloading} />

      <ActivityFeedResults
        args={feedArgs}
        oneDay={dateRange.endDate - dateRange.startDate <= DAY_MS + 3_600_000}
        rangePhrase={reportRangePhrase(dateRange)}
        onClearFilters={filtered ? () => setFilters({}) : undefined}
      />
    </div>
  );
}

type FeedArgs = Omit<FunctionArgs<typeof api.reporting.activityFeed.getActivityFeed>, "paginationOpts">;

function ActivityFeedResults({
  args,
  oneDay,
  rangePhrase,
  onClearFilters,
}: {
  args: FeedArgs;
  oneDay: boolean;
  rangePhrase: string;
  onClearFilters?: () => void;
}) {
  const { results, status, loadMore } = usePaginatedQuery(api.reporting.activityFeed.getActivityFeed, args, {
    initialNumItems: PAGE_SIZE,
  });
  // A filter the index can't apply (entity type, program, payment type) can
  // leave a page empty within its read budget. Keep reading, up to ten pages,
  // until a screenful of matches is in, so nobody clicks through empty pages.
  const argsKey = JSON.stringify(args);
  const autoLoads = useRef({ argsKey, count: 0 });
  useEffect(() => {
    if (autoLoads.current.argsKey !== argsKey) {
      autoLoads.current = { argsKey, count: 0 };
    }
    if (status === "CanLoadMore" && results.length < PAGE_SIZE && autoLoads.current.count < 10) {
      autoLoads.current.count += 1;
      loadMore(PAGE_SIZE);
    }
  }, [argsKey, status, results.length, loadMore]);

  // New filters or a new range keep the last rows on screen, dimmed, until
  // the first page of the new ones arrives (Kept Data While Reloading).
  const firstPage = status === "LoadingFirstPage";
  const [kept, setKept] = useState<typeof results | undefined>(undefined);
  if (!firstPage && kept !== results) setKept(results);
  const events = firstPage ? kept : results;

  return (
    <ActivityFeedList
      events={events}
      pageSize={PAGE_SIZE}
      onLoadMore={() => loadMore(PAGE_SIZE)}
      hasMore={!firstPage && (status === "CanLoadMore" || status === "LoadingMore")}
      loadingMore={status === "LoadingMore"}
      reloading={firstPage && kept !== undefined}
      oneDay={oneDay}
      rangePhrase={rangePhrase}
      onClearFilters={onClearFilters}
    />
  );
}
