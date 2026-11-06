"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { ArrowRightIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useBusinessDay } from "@/hooks/use-business-day";
import { usePageTitle } from "@/hooks/use-page-title";
import { getErrorMessage } from "@/lib/errors";
import {
  formatBatchDuration,
  resparkBucketLabel,
  summarizeBatch,
  type BatchSummary,
} from "@/lib/respark/display";
import { cn } from "@/lib/utils";
import { PageBand } from "@/app/workspace/_components/page-band";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { SectionEmpty, SectionError } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { LeadGenResparkSkeleton } from "./lead-gen-respark-skeleton";
import { ResparkBatch } from "./respark-batch";
import { formatClock } from "./respark-format";
import {
  BandZones,
  FIGURE,
  LABEL,
  RESPARK_CARD,
  RESPARK_ROOT,
  Swatch,
  TITLE_ROW,
  Zone,
  ZONE_FIGURE,
  ZoneBone,
} from "./respark-ui";

const countFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

// setTimeout's longest delay. A later moment re-arms when the timer fires.
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Whether `at` has passed, re-rendering at that moment. */
function useHasPassed(at: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const delay = at - Date.now();
    if (delay <= 0 && now >= at) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(delay, 0), MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [at, now]);
  return at !== null && now >= at;
}

// The pool is the lead generator's team's (plan §11.5), so with no team it's empty.
const NO_TEAM_MESSAGE = "You're not on a lead gen team yet, so you have no respark pool. Ask an admin to add you to a team.";

const START_LINE = "A second pass on people who stalled. Your batch comes from the top of your team's pool.";

// The Respark screen (docs/plans/respark.md §6.1): ask for a batch, work it
// card by card, then a summary. The batch and the pool order come from the
// server; there is no filter and no bucket picker.
export function LeadGenResparkPageClient() {
  usePageTitle("Respark");
  const batch = useQuery(api.respark.queries.getMyResparkBatch, {});
  // The query only re-runs on writes, so the hold's end is timed here.
  const ended = useHasPassed(batch ? batch.heldUntil : null);
  const { setting } = useBusinessDay("lead-gen");
  const claim = useMutation(api.respark.batches.claimResparkBatch);
  const [claiming, setClaiming] = useState(false);

  const getBatch = async () => {
    setClaiming(true);
    try {
      const result = await claim({});
      if (result.noTeam) toast.info(NO_TEAM_MESSAGE);
      else if (result.size === 0) toast.info("No one is in your team's respark pool right now.");
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't get a batch."));
    } finally {
      setClaiming(false);
    }
  };

  if (batch === undefined) {
    return <LeadGenResparkSkeleton label="Loading your batch" />;
  }

  const live = batch !== null && !ended && batch.items.length > 0 ? batch : null;
  const summary = live ? summarizeBatch(live) : null;

  if (live && summary && summary.worked < summary.total) {
    return (
      <div className={RESPARK_ROOT}>
        <ResparkBatch key={live.batchId} batch={live} timeZone={setting.timeZone} />
      </div>
    );
  }

  const done = summary && summary.durationMs !== null ? summary : null;

  return (
    <div className={RESPARK_ROOT}>
      <PageBand
        title="Respark"
        description={START_LINE}
        actions={
          <SectionErrorBoundary
            sectionName="the respark pool"
            fallback={<GetBatchButton again={done !== null} claiming={claiming} onGetBatch={getBatch} />}
          >
            <StartAction again={done !== null} claiming={claiming} onGetBatch={getBatch} />
          </SectionErrorBoundary>
        }
      >
        <SectionErrorBoundary
          sectionName="today's resparks"
          fallback={<p className="-mx-4 border-t border-board-line px-4 py-3 text-[13px] text-board-muted @lg:-mx-[18px] @lg:px-[18px]">Couldn&apos;t load today&apos;s figures.</p>}
        >
          <TodayZones />
        </SectionErrorBoundary>
      </PageBand>

      {done ? <BatchDoneLine summary={done} /> : null}

      <section className={RESPARK_CARD} aria-labelledby="respark-next-batch">
        <SectionErrorBoundary sectionName="the respark pool" fallback={<NextBatchFailed />}>
          <NextBatch timeZone={setting.timeZone} />
        </SectionErrorBoundary>
      </section>
    </div>
  );
}

function GetBatchButton({ again, claiming, onGetBatch }: { again: boolean; claiming: boolean; onGetBatch: () => void }) {
  return (
    <Button onClick={onGetBatch} disabled={claiming} className="h-[34px] rounded-[7px] px-3.5 text-[13px] font-semibold">
      {claiming ? <Spinner data-icon="inline-start" /> : null}
      {again ? "Get another batch" : "Get my batch"}
    </Button>
  );
}

/**
 * The page's one next action, unless there is no team pool. An empty count
 * keeps the button: people join the pool as days pass without a write, so
 * the counts can lag and the claim decides.
 */
function StartAction(props: { again: boolean; claiming: boolean; onGetBatch: () => void }) {
  const pool = useQuery(api.respark.queries.getResparkPoolCounts, {});
  if (pool?.noTeam) return null;
  return <GetBatchButton {...props} />;
}

function TodayZones() {
  const today = useQuery(api.respark.queries.getMyResparkToday, {});
  const figure = (value: number | undefined) =>
    value === undefined ? <ZoneBone /> : <p className={ZONE_FIGURE}>{countFormatter.format(value)}</p>;

  return (
    <BandZones label="Today" className="grid-cols-3">
      <Zone label="Batches today">{figure(today?.batchesDone)}</Zone>
      <Zone label="Entries today">{figure(today?.resparks)}</Zone>
      <Zone label="Not a fit today">{figure(today?.notAFits)}</Zone>
    </BandZones>
  );
}

/** The batch just finished, said once, with the way to the day's record. */
function BatchDoneLine({ summary }: { summary: BatchSummary }) {
  return (
    <section
      aria-label="Batch done"
      className={cn(RESPARK_CARD, "flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2")}
    >
      <p className="min-w-0 text-sm">
        <span className="font-semibold">Batch done</span>
        {summary.durationMs !== null ? <span className="text-muted-foreground"> in {formatBatchDuration(summary.durationMs)}</span> : null}
        <span className="text-muted-foreground">
          {" · "}
          <span className={cn(FIGURE, "text-foreground")}>{summary.entries}</span> {summary.entries === 1 ? "entry" : "entries"}
          {" · "}
          <span className={cn(FIGURE, "text-foreground")}>{summary.notAFit}</span> not a fit
          {" · "}
          <span className={cn(FIGURE, "text-foreground")}>{summary.skipped}</span> skipped
        </span>
      </p>
      <Link href="/workspace/lead-gen/my-activity" className={cn(detailLinkClass, "ml-auto gap-1 text-[13px]")}>
        My activity
        <ArrowRightIcon className="size-3.5" aria-hidden="true" />
      </Link>
    </section>
  );
}

function NextBatchHead({ meta }: { meta?: React.ReactNode }) {
  return (
    <div className={TITLE_ROW}>
      <h2 id="respark-next-batch" className="text-[15px] font-semibold">
        Next batch
      </h2>
      {meta ? <span className="text-[13px] text-muted-foreground">{meta}</span> : null}
    </div>
  );
}

function NextBatchFailed() {
  return (
    <>
      <NextBatchHead />
      <SectionError what="your team's pool" />
    </>
  );
}

function NextBatch({ timeZone }: { timeZone: string }) {
  const pool = useQuery(api.respark.queries.getResparkPoolCounts, {});

  if (pool?.noTeam) {
    return (
      <>
        <NextBatchHead />
        <SectionEmpty title="You're not on a lead gen team yet, so you have no respark pool.">
          Ask an admin to add you to a team.
        </SectionEmpty>
      </>
    );
  }

  if (pool && pool.buckets.every((bucket) => bucket.count === 0)) {
    return (
      <>
        <NextBatchHead />
        <SectionEmpty title="No one is in your team's respark pool right now." />
      </>
    );
  }

  return (
    <>
      <NextBatchHead
        meta={
          pool ? (
            <>
              {pool.batchSize} people ·{" "}
              <HelpTip tip={`The end of the business day, ${timeZone} time. Then the batch ends.`}>
                held until {formatClock(pool.heldUntil, timeZone)}
              </HelpTip>
            </>
          ) : (
            <Skeleton className="inline-block h-3.5 w-40 align-middle" />
          )
        }
      />
      <p className={cn(LABEL, "flex min-h-7 items-end px-4 pt-2 pb-1.5")}>Fills in this order</p>
      <ol aria-label="Fills in this order" className="border-t border-border">
        {(pool?.buckets ?? [1, 2, 3, 4, 5].map((bucket) => ({ bucket, count: undefined }))).map(({ bucket, count }) => (
          <li
            key={bucket}
            className="grid min-h-9 grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-x-2.5 border-b border-border px-4 py-1.5 text-sm last:border-b-0"
          >
            <Swatch bucket={bucket} />
            <span className={cn("truncate", count === 0 && "text-muted-foreground")}>
              {bucket} · {resparkBucketLabel(bucket)}
            </span>
            {count === undefined ? (
              <Skeleton className="h-4 w-10" />
            ) : (
              <span className={cn(FIGURE, "text-right", count === 0 && "text-muted-foreground")}>
                {countFormatter.format(count)}
              </span>
            )}
          </li>
        ))}
      </ol>
    </>
  );
}
