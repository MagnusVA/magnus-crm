"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { startOfMonth, endOfMonth } from "date-fns";
import { AlertTriangleIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  ReportDateControls,
  type DateRange,
} from "@/app/workspace/reports/_components/report-date-controls";
import { ActivityFeedSkeleton } from "./activity-feed-skeleton";
import { ActivitySummaryCards } from "./activity-summary-cards";
import { ActivityFeedFilters } from "./activity-feed-filters";
import { ActivityFeedList } from "./activity-feed-list";

type EntityType =
  | "customer"
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
}

export function ActivityFeedPageClient() {
  usePageTitle("Activity Feed");

  const now = new Date();
  const [dateRange, setDateRange] = useState<DateRange>({
    startDate: startOfMonth(now).getTime(),
    endDate: endOfMonth(now).getTime(),
  });
  const [filters, setFilters] = useState<Filters>({});
  const [limit, setLimit] = useState(50);

  // Reset limit when filters or date range change
  useEffect(() => {
    setLimit(50);
  }, [dateRange.startDate, dateRange.endDate, filters.entityType, filters.eventType, filters.actorUserId]);

  const summary = useQuery(api.reporting.activityFeed.getActivitySummary, dateRange);

  // Only include defined filter values in query args
  const feedArgs = {
    ...dateRange,
    limit,
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.eventType ? { eventType: filters.eventType } : {}),
    ...(filters.actorUserId
      ? { actorUserId: filters.actorUserId as Id<"users"> }
      : {}),
  };
  const feed = useQuery(api.reporting.activityFeed.getActivityFeed, feedArgs);

  if (summary === undefined) {
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
        <h1 className="text-2xl font-semibold tracking-tight">
          Activity Feed
        </h1>
        <p className="text-sm text-muted-foreground">
          Audit trail of all CRM actions — who did what and when
        </p>
      </div>

      {/* Date range controls */}
      <ReportDateControls value={dateRange} onChange={setDateRange} />

      {/* Summary cards */}
      <ActivitySummaryCards summary={summary} />

      {/* Truncation warning */}
      {summary.isTruncated && (
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
        actorBreakdown={summary.actorBreakdown ?? []}
      />

      {/* Event list */}
      <ActivityFeedList
        events={feed ?? []}
        onLoadMore={() => setLimit((prev) => Math.min(prev + 50, 100))}
        hasMore={feed !== undefined && feed.length === limit && limit < 100}
        isLoading={feed === undefined}
      />
    </div>
  );
}
