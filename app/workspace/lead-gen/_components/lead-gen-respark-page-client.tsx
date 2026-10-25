"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
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
} from "@/lib/respark/display";
import { cn } from "@/lib/utils";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { ResparkBatch } from "./respark-batch";
import { bucketSwatchClass, formatClock } from "./respark-format";

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
      if (result.size === 0) toast.info("No one is in the respark pool right now.");
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't get a batch."));
    } finally {
      setClaiming(false);
    }
  };

  if (batch === undefined) {
    return (
      <div className="flex flex-col gap-5" role="status" aria-label="Loading your batch">
        <ResparkHeader />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const live = batch !== null && !ended && batch.items.length > 0 ? batch : null;
  const summary = live ? summarizeBatch(live) : null;

  if (live && summary && summary.worked < summary.total) {
    return (
      <ResparkBatch
        key={live.batchId}
        batch={live}
        timeZone={setting.timeZone}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <ResparkHeader />
      {summary && summary.durationMs !== null ? (
        <BatchDone summary={summary} claiming={claiming} onGetBatch={getBatch} />
      ) : (
        <StartCard claiming={claiming} onGetBatch={getBatch} timeZone={setting.timeZone} />
      )}
    </div>
  );
}

function ResparkHeader() {
  return (
    <header className="flex flex-col gap-1 border-b pb-5">
      <h1 className="text-2xl font-semibold tracking-normal text-pretty">Respark</h1>
      <p className="text-sm text-muted-foreground">
        A second pass on people who stalled. Your batch comes from the top of the pool.
      </p>
    </header>
  );
}

function StartCard({
  claiming,
  onGetBatch,
  timeZone,
}: {
  claiming: boolean;
  onGetBatch: () => void;
  timeZone: string;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border bg-card p-4" aria-labelledby="respark-next-batch">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="respark-next-batch" className="text-base font-semibold">Your next batch</h2>
        <Button onClick={onGetBatch} disabled={claiming} className="self-start sm:self-auto">
          {claiming ? <Spinner data-icon="inline-start" /> : null}
          Get my batch
        </Button>
      </div>

      <SectionErrorBoundary sectionName="the respark pool">
        <PoolCounts timeZone={timeZone} />
      </SectionErrorBoundary>

      <SectionErrorBoundary sectionName="today's resparks">
        <TodaySummary />
      </SectionErrorBoundary>
    </section>
  );
}

function PoolCounts({ timeZone }: { timeZone: string }) {
  const pool = useQuery(api.respark.queries.getResparkPoolCounts, {});

  return (
    <div className="flex flex-col gap-4">
      {pool ? (
        <p className="text-sm text-muted-foreground">
          {pool.batchSize} people, held for you until {formatClock(pool.heldUntil, timeZone)} ({timeZone}), the end of the business day
        </p>
      ) : (
        <Skeleton className="h-4 w-80 max-w-full" />
      )}

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">Your batch fills in this order</p>
        <ol className="flex flex-col gap-1.5">
          {(pool?.buckets ?? [1, 2, 3, 4, 5].map((bucket) => ({ bucket, count: undefined }))).map(
            ({ bucket, count }) => (
              <li
                key={bucket}
                className={cn(
                  "grid grid-cols-[0.75rem_1fr_auto] items-center gap-2.5 rounded-md border px-3 py-2 text-sm",
                  count === 0 && "text-muted-foreground",
                )}
              >
                <span aria-hidden="true" className={cn("size-3 rounded-[3px]", bucketSwatchClass(bucket))} />
                <span>
                  {bucket} · {resparkBucketLabel(bucket)}
                </span>
                {count === undefined ? (
                  <Skeleton className="h-4 w-12" />
                ) : (
                  <span className="font-medium tabular-nums">{countFormatter.format(count)}</span>
                )}
              </li>
            ),
          )}
        </ol>
      </div>
    </div>
  );
}

function TodaySummary() {
  const today = useQuery(api.respark.queries.getMyResparkToday, {});

  return today ? (
    <p className="text-xs text-muted-foreground">
      Today: {today.batchesDone} {today.batchesDone === 1 ? "batch" : "batches"} done ·{" "}
      {today.resparks} {today.resparks === 1 ? "entry" : "entries"} · {today.notAFits} not a fit
    </p>
  ) : (
    <Skeleton className="h-4 w-64" />
  );
}

function BatchDone({
  summary,
  claiming,
  onGetBatch,
}: {
  summary: ReturnType<typeof summarizeBatch>;
  claiming: boolean;
  onGetBatch: () => void;
}) {
  return (
    <section
      className="flex flex-col items-center gap-4 rounded-lg border bg-card px-5 py-8 text-center"
      aria-labelledby="respark-batch-done"
    >
      <div className="flex flex-col gap-1">
        <p className="text-4xl font-semibold tabular-nums">
          {summary.worked} / {summary.total}
        </p>
        <h2 id="respark-batch-done" className="text-sm text-muted-foreground">
          Batch done{summary.durationMs !== null ? `, ${formatBatchDuration(summary.durationMs)}` : ""}
        </h2>
      </div>
      <dl className="grid w-full max-w-lg grid-cols-3 gap-3 text-left">
        <DoneMetric label="Entries" value={summary.entries} />
        <DoneMetric label="Not a fit" value={summary.notAFit} />
        <DoneMetric label="Skipped" value={summary.skipped} />
      </dl>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={onGetBatch} disabled={claiming}>
          {claiming ? <Spinner data-icon="inline-start" /> : null}
          Get another batch
        </Button>
        <Button variant="outline" asChild>
          <Link href="/workspace/lead-gen/my-activity">See My Activity</Link>
        </Button>
      </div>
    </section>
  );
}

function DoneMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
