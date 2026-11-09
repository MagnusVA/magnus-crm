"use client";

import Link from "next/link";
import { format } from "date-fns";
import type { PipelineNow } from "@/convex/reports/pipeline";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCardFooter, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { cn } from "@/lib/utils";
import {
  COLUMN_HEAD,
  FIGURE_15,
  FIGURE_20,
  LABEL,
  ReportCard,
  ReportNote,
  RowsSkeleton,
  StatusWord,
} from "../../_components/report-ui";
import { formatCount, formatDays, nextStepWords, stageLabel } from "./pipeline-shape";

// Pipeline's cards (§12): stages, the oldest open deals, the calls that owe
// a result and the booking reviews waiting. Every row opens its deal or call.

const shortDate = (at: number) => format(at, "MMM d");

export function dealHref(opportunityId: string) {
  return `/workspace/opportunities/${opportunityId}`;
}

export function callHref(meetingId: string) {
  return `/workspace/pipeline/meetings/${meetingId}`;
}

export function StagesCard({ data }: { data: PipelineNow | undefined }) {
  const partial = data?.stages.some((stage) => stage.partial) ?? false;
  return (
    <ReportCard title="Stages" meta="Days since each deal entered its stage" container="@container/stages">
      {data === undefined ? (
        <RowsSkeleton rows={4} label="Loading stages" />
      ) : (
        <>
          {partial ? (
            <ReportNote lead="Partial.">
              A stage holds more deals than one read covers, so its ages come from the deals read.
            </ReportNote>
          ) : null}
          <table className="w-full border-collapse">
            <caption className="sr-only">Open deals by stage, with the median and oldest days in the stage</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
                  Stage
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                  Deals
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                  Median
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "pr-4 text-right")}>
                  Oldest
                </th>
              </tr>
            </thead>
            <tbody>
              {data.stages.map((stage) => {
                const quiet = stage.count === 0;
                return (
                  <tr key={stage.stage} className="h-11 border-b last:border-b-0">
                    <th scope="row" className="pr-3 pl-4 text-left font-medium">
                      {stageLabel(stage.stage)}
                    </th>
                    <td className={cn(FIGURE_15, "px-2.5 text-right", quiet && "text-muted-foreground")}>
                      {formatCount(stage.count)}
                      {stage.partial ? "+" : ""}
                    </td>
                    <td className={cn(FIGURE_15, "px-2.5 text-right whitespace-nowrap", quiet && "text-muted-foreground")}>
                      {formatDays(stage.medianAgeDays, 1)}
                    </td>
                    <td className={cn(FIGURE_15, "pr-4 pl-2.5 text-right whitespace-nowrap", quiet && "text-muted-foreground")}>
                      {formatDays(stage.oldestAgeDays)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </ReportCard>
  );
}

const AGING_COLUMNS =
  "@3xl/aging:grid @3xl/aging:grid-cols-[minmax(0,1.2fr)_7rem_5.5rem_minmax(0,1fr)_8rem] @3xl/aging:items-center @3xl/aging:gap-3";

export function AgingCard({ data }: { data: PipelineNow | undefined }) {
  const deals = data?.aging.deals ?? [];
  return (
    <ReportCard
      title="Aging"
      meta={data ? `The ${formatCount(deals.length)} oldest open deal${deals.length === 1 ? "" : "s"}` : undefined}
      container="@container/aging"
    >
      {data === undefined ? (
        <RowsSkeleton rows={8} label="Loading the oldest open deals" />
      ) : deals.length === 0 ? (
        <SectionEmpty title="No open deals right now." />
      ) : (
        <>
          {data.aging.partial ? (
            <ReportNote lead="Partial.">There are more open deals than one read covers; these are the oldest of those read.</ReportNote>
          ) : null}
          <div className={cn("hidden border-b px-4", AGING_COLUMNS)}>
            <span className={cn(COLUMN_HEAD, "px-0")}>Deal</span>
            <span className={cn(COLUMN_HEAD, "px-0")}>Stage</span>
            <span className={cn(COLUMN_HEAD, "px-0 text-right")}>In stage</span>
            <span className={cn(COLUMN_HEAD, "px-0")}>Closer</span>
            <span className={cn(COLUMN_HEAD, "px-0")}>Next step</span>
          </div>
          <ul aria-label="The oldest open deals">
            {deals.map((deal) => {
              const next = nextStepWords(deal.nextStep, shortDate);
              return (
                <li key={deal.opportunityId} className="border-b last:border-b-0">
                  <div className={cn("flex min-h-11 flex-col justify-center gap-0.5 px-4 py-2 @3xl/aging:py-0", AGING_COLUMNS)}>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <Link href={dealHref(deal.opportunityId)} className={cn(detailLinkClass, "min-w-0 truncate")}>
                        {deal.leadName}
                      </Link>
                      <span className={cn(FIGURE_15, "whitespace-nowrap @3xl/aging:hidden")}>{formatDays(deal.ageDays)}</span>
                    </div>
                    <p className="truncate text-[13px] text-muted-foreground @3xl/aging:hidden">
                      {stageLabel(deal.stage)} · {deal.closerName ?? "No closer"} · {next ?? "No next step"}
                    </p>
                    <span className="hidden text-[13px] @3xl/aging:block">{stageLabel(deal.stage)}</span>
                    <span className={cn(FIGURE_15, "hidden text-right whitespace-nowrap @3xl/aging:block")}>{formatDays(deal.ageDays)}</span>
                    <span className={cn("hidden truncate text-[13px] @3xl/aging:block", !deal.closerName && "text-muted-foreground")}>
                      {deal.closerName ?? "No closer"}
                    </span>
                    <span className="hidden @3xl/aging:block">
                      {next ? <span className="text-[13px]">{next}</span> : <StatusWord tone="owed">No next step</StatusWord>}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </ReportCard>
  );
}

export function OwedCard({ data }: { data: PipelineNow | undefined }) {
  const calls = data?.owed.calls ?? [];
  const total = data?.owed.total ?? null;
  return (
    <ReportCard
      title="Calls owed a result"
      meta="Oldest first"
      container="@container/owed"
      footer={
        data && total !== null && total > calls.length ? (
          <DetailCardFooter className="font-normal">
            <span className="text-[13px]">
              Showing the oldest {formatCount(calls.length)} of {formatCount(total)}
            </span>
          </DetailCardFooter>
        ) : undefined
      }
    >
      {data === undefined ? (
        <RowsSkeleton rows={6} label="Loading calls owed a result" />
      ) : calls.length === 0 && total === 0 && !data.owed.partial ? (
        <SectionEmpty title="Every past call has a result." />
      ) : (
        <>
          {total === null ? (
            <ReportNote lead="Partial.">The exact count couldn&apos;t be read, so the band shows a dash. These are the oldest found.</ReportNote>
          ) : data.owed.partial ? (
            <ReportNote lead="Partial.">More calls may owe a result than one read covers.</ReportNote>
          ) : null}
          {calls.length === 0 ? (
            <SectionEmpty title="No calls owing a result were found in the read." />
          ) : (
            <ul aria-label="Calls owed a result">
              {calls.map((call) => (
                <li key={call.meetingId} className="flex min-h-11 items-center justify-between gap-3 border-b px-4 py-2 last:border-b-0">
                  <div className="min-w-0">
                    <Link href={dealHref(call.opportunityId)} className={cn(detailLinkClass, "max-w-full truncate")}>
                      {call.leadName}
                    </Link>
                    <p className="truncate text-[13px] text-muted-foreground">
                      {call.closerName} ·{" "}
                      <Link href={callHref(call.meetingId)} className={detailLinkClass}>
                        Call {format(call.scheduledAt, "MMM d · h:mm a")}
                      </Link>
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <StatusWord tone="owed">Not recorded</StatusWord>
                    <span className={cn(FIGURE_15, "text-muted-foreground")}>{formatDays(call.ageDays)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </ReportCard>
  );
}

export function BookingReviewsCard({ data }: { data: PipelineNow | undefined }) {
  const reviews = data?.bookingReviews;
  return (
    <ReportCard title="Booking reviews waiting" container="@container/reviews">
      {reviews === undefined ? (
        <RowsSkeleton rows={2} label="Loading booking reviews" />
      ) : reviews.count === 0 ? (
        <SectionEmpty title="No booking reviews waiting." />
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-4 px-4 py-3">
          <div className="flex flex-col gap-1">
            <p className={LABEL}>Waiting</p>
            <p className={FIGURE_20}>
              {formatCount(reviews.count)}
              {reviews.partial ? "+" : ""}
            </p>
            {reviews.oldest ? (
              <p className="text-[13px] text-muted-foreground">
                Oldest waiting {formatDays(reviews.oldest.ageDays)} ·{" "}
                <Link href={`/workspace/operations/booking-reviews/${reviews.oldest.reviewId}`} className={detailLinkClass}>
                  Open it
                </Link>
              </p>
            ) : null}
          </div>
          <Link href="/workspace/operations/booking-reviews" className={cn(detailLinkClass, "text-[13px]")}>
            Open booking reviews
          </Link>
        </div>
      )}
    </ReportCard>
  );
}
