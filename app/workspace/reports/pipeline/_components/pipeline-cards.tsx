"use client";

import { useState } from "react";
import Link from "next/link";
import { usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { format } from "date-fns";
import { api } from "@/convex/_generated/api";
import type { PipelineNow } from "@/convex/reports/pipeline";
import { pipelineNextStep } from "@/convex/reports/lib/pipelineNextStep";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { LIST_PAGE_SIZE, PageRows, ReportPager, useCursorPages, useKeptCursorList } from "../../_components/report-paging";
import { COLUMN_HEAD, FIGURE_15, ReportCard, RowsSkeleton, StatusWord } from "../../_components/report-ui";
import { formatCount, formatDays, nextStepWords, openDealCount, stageLabel } from "./pipeline-shape";

// Pipeline's cards (§12): the stages as one strip, then the two worklists,
// calls that owe a result and the oldest open deals. Each worklist is a page
// of ten from its own paginated query, so the page keeps its height however
// many deals are open. Every row opens its deal or call.

const DAY = 86_400_000;
const shortDate = (at: number) => format(at, "MMM d");

type OpenDealRow = FunctionReturnType<typeof api.reports.pipeline.listOpenDeals>["page"][number];
type OwedCallRow = FunctionReturnType<typeof api.reports.pipeline.listOwedCalls>["page"][number];

export function dealHref(opportunityId: string) {
  return `/workspace/opportunities/${opportunityId}`;
}

export function callHref(meetingId: string) {
  return `/workspace/pipeline/meetings/${meetingId}`;
}

// A stage is named in its stage ink (DESIGN.md, The One Scale Rule).
// Qualified borrows the Held slate.
const STAGE_INK: Record<PipelineNow["stages"][number]["stage"], string> = {
  qualified: "text-stage-held-ink",
  booked: "text-stage-booked-ink",
  call_held: "text-stage-held-ink",
  follow_up: "text-stage-follow-up-ink",
};

const STAGE_WORD = "font-condensed text-[13px] leading-[1.1] font-bold tracking-[0.08em] uppercase";

/** The four open stages side by side, in the order a deal moves through them. */
export function StagesCard({ data }: { data: PipelineNow | undefined }) {
  const partial = data?.stages.some((stage) => stage.partial) ?? false;
  return (
    <ReportCard
      title="Stages"
      meta={partial ? "Ages come from the deals read, where a stage holds more than one read covers" : "Deal age: days since each open deal was created"}
      container="@container/stages"
    >
      {data === undefined ? (
        <div role="status" aria-label="Loading stages" className="grid grid-cols-2 gap-px bg-border @3xl/stages:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5 bg-card px-4 py-3">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-6 w-12" />
              <Skeleton className="h-3.5 w-40 max-w-full" />
            </div>
          ))}
        </div>
      ) : (
        <dl className="grid grid-cols-2 gap-px bg-border @3xl/stages:grid-cols-4">
          {data.stages.map((stage) => {
            const quiet = stage.count === 0;
            return (
              <div key={stage.stage} className="flex min-w-0 flex-col gap-1 bg-card px-4 py-3">
                <dt className={cn(STAGE_WORD, quiet ? "text-muted-foreground" : STAGE_INK[stage.stage])}>{stageLabel(stage.stage)}</dt>
                <dd className="flex flex-col gap-1">
                  <span className={cn("font-condensed text-[26px] leading-none font-semibold tabular-nums", quiet && "text-muted-foreground")}>
                    {formatCount(stage.count)}
                    {stage.partial ? "+" : ""}
                    <span className="sr-only"> open deals</span>
                  </span>
                  <span className="text-[13px] text-muted-foreground">
                    {quiet ? (
                      "No open deals"
                    ) : (
                      <>
                        Median <span className={cn(FIGURE_15, "text-foreground")}>{formatDays(stage.medianAgeDays, 1)}</span> · oldest{" "}
                        <span className={cn(FIGURE_15, "text-foreground")}>{formatDays(stage.oldestAgeDays)}</span>
                      </>
                    )}
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </ReportCard>
  );
}

/**
 * Booking reviews waiting, as one line under the band, shown only while some
 * wait: the band already carries the count, so an empty card would repeat it.
 */
export function BookingReviewsLine({ data }: { data: PipelineNow | undefined }) {
  const reviews = data?.bookingReviews;
  if (!reviews || reviews.count === 0) return null;
  const count = `${formatCount(reviews.count)}${reviews.partial ? "+" : ""}`;
  return (
    <DetailCard
      title={`${count} booking review${reviews.count === 1 && !reviews.partial ? "" : "s"} waiting`}
      meta={
        <>
          {reviews.oldest ? (
            <span className="hidden @2xl:inline">
              Oldest waiting <span className={cn(FIGURE_15, "text-foreground")}>{formatDays(reviews.oldest.ageDays)}</span>
            </span>
          ) : null}
          {reviews.oldest ? (
            <Link href={`/workspace/operations/booking-reviews/${reviews.oldest.reviewId}`} className={detailLinkClass}>
              Open the oldest
            </Link>
          ) : null}
          <Link href="/workspace/operations/booking-reviews" className={detailLinkClass}>
            All reviews
          </Link>
        </>
      }
      metaClassName="gap-4"
      className="min-w-0 [&>div:first-child]:border-b-0"
    >
      {null}
    </DetailCard>
  );
}

const AGE = cn(FIGURE_15, "whitespace-nowrap");

const OWED_COLUMNS =
  "@2xl/owed:grid @2xl/owed:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_9.5rem_5.5rem] @2xl/owed:items-center @2xl/owed:gap-3";

/**
 * Calls whose time has passed with no result, oldest first. The list follows
 * the minute clock while its first page shows; further in, the cutoff holds
 * so the rows don't shift under the reader.
 */
export function OwedCard({ data, now }: { data: PipelineNow | undefined; now: number }) {
  const [heldAt, setHeldAt] = useState<number | null>(null);
  const endedBy = heldAt ?? now;
  // A new minute restarts the query; the last rows stay until it answers.
  const list = useKeptCursorList(
    usePaginatedQuery(api.reports.pipeline.listOwedCalls, { endedBy }, { initialNumItems: 2 * LIST_PAGE_SIZE }),
  );
  const paged = useCursorPages(list, { total: data?.owed.total ?? null, totalIsMinimum: data?.owed.partial ?? false });
  const { rows, firstLoad } = paged;
  // The page asked for, not the rows shown: Next can be waiting for its rows.
  const onFirstPage = paged.page === 0;
  // Back on the first page (by Previous, or because calls got their results
  // and the list shrank), the list follows the clock again.
  if (heldAt !== null && onFirstPage) setHeldAt(null);
  const pager = {
    ...paged.pager,
    next: () => {
      // Leaving the first page holds the cutoff, so rows don't shift under the reader.
      if (onFirstPage && paged.pager.full) setHeldAt(now);
      paged.pager.next();
    },
  };
  return (
    <ReportCard
      title="Calls owed a result"
      meta="Oldest first"
      container="@container/owed"
      footer={firstLoad ? undefined : <ReportPager pager={pager} noun="calls" />}
    >
      {firstLoad ? (
        <RowsSkeleton rows={LIST_PAGE_SIZE} rowHeight="h-[52px]" label="Loading calls owed a result" />
      ) : rows.length === 0 && !pager.hasNext ? (
        <SectionEmpty title="Every past call has a result." />
      ) : rows.length === 0 ? (
        <SectionEmpty title="No calls owing a result in the calls read so far.">Next reads further.</SectionEmpty>
      ) : (
        <>
          <div className={cn("hidden border-b px-4", OWED_COLUMNS)}>
            <span className={cn(COLUMN_HEAD, "px-0")}>Person</span>
            <span className={cn(COLUMN_HEAD, "px-0")}>Closer</span>
            <span className={cn(COLUMN_HEAD, "px-0")}>Call</span>
            <span className={cn(COLUMN_HEAD, "px-0 text-right")}>Owed for</span>
          </div>
          <PageRows pager={pager}>
            <ul aria-label="Calls owed a result">
              {rows.map((call: OwedCallRow) => {
                const age = formatDays(Math.max(0, (now - call.endsAt) / DAY));
                const callLink = (
                  <Link href={callHref(call.meetingId)} className={cn(detailLinkClass, "font-medium whitespace-nowrap")}>
                    {format(call.scheduledAt, "MMM d · h:mm a")}
                  </Link>
                );
                return (
                  <li key={call.meetingId} className="border-b last:border-b-0">
                    <div className={cn("flex min-h-[52px] flex-col justify-center gap-0.5 px-4 py-1.5 @2xl/owed:min-h-11 @2xl/owed:py-0", OWED_COLUMNS)}>
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <Link href={dealHref(call.opportunityId)} className={cn(detailLinkClass, "min-w-0 truncate")}>
                          {call.leadName}
                        </Link>
                        <span className={cn(AGE, "text-warning-ink @2xl/owed:hidden")}>{age}</span>
                      </div>
                      <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground @2xl/owed:hidden">
                        <span className="truncate">{call.closerName}</span>
                        <span aria-hidden="true">·</span>
                        {callLink}
                      </p>
                      <span className="hidden truncate text-[13px] @2xl/owed:block">{call.closerName}</span>
                      <span className="hidden text-[13px] @2xl/owed:block">{callLink}</span>
                      <span className={cn(AGE, "hidden text-right text-warning-ink @2xl/owed:block")}>{age}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </PageRows>
        </>
      )}
    </ReportCard>
  );
}

const AGING_COLUMNS =
  "@2xl/aging:grid @2xl/aging:grid-cols-[minmax(0,1.3fr)_5.5rem_minmax(0,1fr)_7.5rem_5.5rem] @2xl/aging:items-center @2xl/aging:gap-3";

/** Every open deal, oldest first, a page at a time. */
export function AgingCard({ data, now }: { data: PipelineNow | undefined; now: number }) {
  const list = usePaginatedQuery(api.reports.pipeline.listOpenDeals, {}, { initialNumItems: 2 * LIST_PAGE_SIZE });
  // A stage read past its cap counts "125+", so the total is a floor until every deal has loaded.
  const { rows, firstLoad, pager } = useCursorPages(list, {
    total: data ? openDealCount(data) : null,
    totalIsMinimum: data?.stages.some((stage) => stage.partial) ?? false,
  });
  return (
    <ReportCard
      title="Open deals by age"
      meta="Oldest first"
      container="@container/aging"
      footer={firstLoad ? undefined : <ReportPager pager={pager} noun="deals" />}
    >
      {firstLoad ? (
        <RowsSkeleton rows={LIST_PAGE_SIZE} rowHeight="h-[52px]" label="Loading the oldest open deals" />
      ) : rows.length === 0 ? (
        <SectionEmpty title="No open deals right now." />
      ) : (
        <>
          <div className={cn("hidden border-b px-4", AGING_COLUMNS)}>
            <span className={cn(COLUMN_HEAD, "px-0")}>Person</span>
            <span className={cn(COLUMN_HEAD, "px-0")}>Stage</span>
            <span className={cn(COLUMN_HEAD, "px-0")}>Closer</span>
            <span className={cn(COLUMN_HEAD, "px-0")}>Next step</span>
            <span className={cn(COLUMN_HEAD, "px-0 text-right")}>Age</span>
          </div>
          <PageRows pager={pager}>
            <ul aria-label="Open deals, oldest first">
              {rows.map((deal: OpenDealRow) => {
                const next = nextStepWords(pipelineNextStep(deal, now), shortDate);
                const age = formatDays(Math.max(0, (now - deal.createdAt) / DAY));
                const nextStep = next ? <span className="text-[13px]">{next}</span> : <StatusWord tone="owed">No next step</StatusWord>;
                return (
                  <li key={deal.opportunityId} className="border-b last:border-b-0">
                    <div className={cn("flex min-h-[52px] flex-col justify-center gap-0.5 px-4 py-1.5 @2xl/aging:min-h-11 @2xl/aging:py-0", AGING_COLUMNS)}>
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <Link href={dealHref(deal.opportunityId)} className={cn(detailLinkClass, "min-w-0 truncate")}>
                          {deal.leadName}
                        </Link>
                        <span className={cn(AGE, "@2xl/aging:hidden")}>{age}</span>
                      </div>
                      <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground @2xl/aging:hidden">
                        <span className="truncate">
                          {stageLabel(deal.stage)} · {deal.closerName ?? "No closer"}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">{nextStep}</span>
                      </p>
                      <span className="hidden text-[13px] @2xl/aging:block">{stageLabel(deal.stage)}</span>
                      <span className={cn("hidden truncate text-[13px] @2xl/aging:block", !deal.closerName && "text-muted-foreground")}>
                        {deal.closerName ?? "No closer"}
                      </span>
                      <span className="hidden @2xl/aging:block">{nextStep}</span>
                      <span className={cn(AGE, "hidden text-right @2xl/aging:block")}>{age}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </PageRows>
        </>
      )}
    </ReportCard>
  );
}
