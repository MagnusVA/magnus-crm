"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { LABEL, ReportCard } from "@/app/workspace/reports/_components/report-ui";
import { cn } from "@/lib/utils";
import { ActivityEventRow, FEED_COLUMNS, type ActivityEvent } from "./activity-event-row";

// The Events card: the feed newest first as ruled rows, with a 40px footer
// that loads the next page while more can load.

export function ActivityFeedList({
  events,
  pageSize,
  onLoadMore,
  hasMore,
  loadingMore,
  reloading,
  oneDay,
  rangePhrase,
  onClearFilters,
}: {
  /** Undefined until the first page arrives. */
  events: ActivityEvent[] | undefined;
  pageSize: number;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  /** Kept rows from the last filters, dimmed while the new ones load. */
  reloading: boolean;
  /** The band's range is one day, so rows show the time alone. */
  oneDay: boolean;
  /** "today", "this week", "in this range". */
  rangePhrase: string;
  /** Set while any filter is applied. */
  onClearFilters?: () => void;
}) {
  const count = events?.length ?? 0;
  return (
    <ReportCard
      title="Events"
      meta={
        events === undefined || count === 0 ? (
          "Newest first"
        ) : (
          <>
            <span className="font-condensed text-[14px] font-semibold tabular-nums">{count.toLocaleString()}</span>
            {hasMore ? " shown" : ""} · newest first
          </>
        )
      }
      container="@container/feed"
      reloading={reloading}
      footer={
        events !== undefined && hasMore ? (
          <div className="flex min-h-10 items-center justify-between gap-3 border-t border-border px-4 py-1.5 text-[13px] text-muted-foreground">
            <p role="status" className="flex items-center gap-2">
              {loadingMore ? <Spinner aria-hidden="true" className="size-3.5" /> : null}
              {loadingMore ? "Loading…" : count > 0 ? `Showing ${count.toLocaleString()} events` : "Matches may be further back"}
            </p>
            <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loadingMore}>
              Show {pageSize} more
            </Button>
          </div>
        ) : null
      }
    >
      {events === undefined ? (
        <FeedSkeleton />
      ) : count === 0 && !hasMore ? (
        <SectionEmpty title={onClearFilters ? `No activity matches these filters ${rangePhrase}.` : `No activity ${rangePhrase}.`}>
          {onClearFilters ? (
            <button type="button" onClick={onClearFilters} className={cn(detailLinkClass, "text-[13px]")}>
              Clear filters
            </button>
          ) : (
            "Every change to a meeting, deal, payment or reminder shows here."
          )}
        </SectionEmpty>
      ) : count === 0 ? (
        // Matches may sit further back: the footer keeps "Show more" so the
        // reader can keep looking after the automatic loads stop.
        <p role="status" className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
          {loadingMore ? <Spinner aria-hidden="true" className="size-3.5" /> : null}
          {loadingMore ? "Looking further back for matches…" : "No matches in the events read so far."}
        </p>
      ) : (
        <>
          <div className={cn("hidden min-h-7 items-end border-b border-border px-4 pb-1.5", FEED_COLUMNS, LABEL)}>
            <span>
              <HelpTip tip="Times follow your browser's time zone.">When</HelpTip>
            </span>
            <span>Who</span>
            <span>What</span>
            <span>Record</span>
            <span>Status</span>
          </div>
          <ul aria-label="Activity events">
            {events.map((event) => (
              <ActivityEventRow key={event._id} event={event} oneDay={oneDay} />
            ))}
          </ul>
        </>
      )}
    </ReportCard>
  );
}

/** The feed's rows while the first page loads: 44px from @3xl, two lines narrower. */
function FeedSkeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading activity">
      <div className="hidden min-h-7 border-b border-border @3xl/feed:block" />
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex min-h-[55px] flex-col justify-center gap-1.5 border-b border-border px-4 py-2 last:border-b-0 @3xl/feed:h-11 @3xl/feed:min-h-0 @3xl/feed:flex-row @3xl/feed:items-center @3xl/feed:gap-3 @3xl/feed:py-0"
        >
          <Skeleton className="hidden h-3.5 w-[7.5rem] @3xl/feed:block" />
          <Skeleton className="h-4 w-48 max-w-full" />
          <Skeleton className="h-3 w-56 max-w-full @3xl/feed:hidden" />
          <Skeleton className="hidden h-3.5 w-[30%] @3xl/feed:block" />
          <Skeleton className="ml-auto hidden h-3.5 w-16 @3xl/feed:block" />
        </div>
      ))}
    </div>
  );
}
