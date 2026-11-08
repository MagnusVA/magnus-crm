"use client";

import { CircleXIcon, Clock3Icon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/hooks/use-now";
import type { AnalyticsFreshness } from "./use-analytics-report";

/** Older than this, the reporting data is called delayed (§8.2). */
const DELAYED_AFTER_MS = 8 * 60 * 60 * 1000;

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatAsOf(timestamp: number, now: number) {
  const sameDay = new Date(timestamp).toDateString() === new Date(now).toDateString();
  return (sameDay ? TIME_FORMAT : DATE_TIME_FORMAT).format(new Date(timestamp));
}

type WarehouseFreshness = Extract<AnalyticsFreshness, { source: "warehouse" }>;

/**
 * Where the page's numbers come from, in one of two forms: a line ("Live",
 * "Data as of 2:31 PM", "Today live · earlier days as of 2:31 PM"), or an
 * alert for the reporting database's loading, queued and failed states.
 * A delayed refresh adds an alert to its line.
 */
export type FreshnessSummary =
  | { kind: "line"; label: string; live: boolean; delayedSince: string | null }
  | { kind: "failed"; message: string; retry: () => void }
  | { kind: "loading" }
  | { kind: "queued" };

export function freshnessSummary(items: readonly AnalyticsFreshness[], now: number): FreshnessSummary {
  const warehouse = items.filter((item): item is WarehouseFreshness => item.source === "warehouse");
  if (warehouse.length === 0) return { kind: "line", label: "Live", live: true, delayedSince: null };

  const failed = warehouse.filter((item) => item.state === "failed");
  if (failed.length > 0) {
    return {
      kind: "failed",
      message: failed[0].errorMessage ?? "The reporting database didn't answer.",
      retry: () => failed.forEach((item) => item.retry()),
    };
  }
  if (warehouse.some((item) => item.state === "loading" || (item.state === "pending" && !item.refreshing))) {
    return { kind: "loading" };
  }
  if (warehouse.some((item) => item.state === "queued")) return { kind: "queued" };

  const asOf = Math.min(...warehouse.map((item) => item.asOf ?? Number.POSITIVE_INFINITY));
  const refreshing = warehouse.some((item) => item.refreshing);
  const liveToday = warehouse.some((item) => item.liveToday);
  const label = liveToday
    ? Number.isFinite(asOf)
      ? `Today live · earlier days as of ${formatAsOf(asOf, now)}`
      : "Today live · earlier days from the last sync"
    : Number.isFinite(asOf)
      ? `Data as of ${formatAsOf(asOf, now)}`
      : "Data from the last sync";
  return {
    kind: "line",
    label: refreshing ? `${label} · Refreshing` : label,
    live: liveToday,
    delayedSince: Number.isFinite(asOf) && now - asOf > DELAYED_AFTER_MS ? formatAsOf(asOf, now) : null,
  };
}

/** The reporting database's states that need more than a line, or nothing. */
export function AnalyticsFreshnessAlert({ summary }: { summary: FreshnessSummary }) {
  if (summary.kind === "failed") {
    return (
      <Alert variant="destructive">
        <CircleXIcon aria-hidden="true" />
        <AlertTitle>This range couldn&apos;t be loaded</AlertTitle>
        <AlertDescription>{summary.message}</AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={summary.retry}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (summary.kind === "loading") {
    return (
      <Alert aria-busy="true">
        <Spinner aria-label="Loading from the reporting database" />
        <AlertTitle>Loading from the reporting database</AlertTitle>
        <AlertDescription>
          This range is being prepared in the background. You can keep working while it finishes.
        </AlertDescription>
      </Alert>
    );
  }
  if (summary.kind === "queued") {
    return (
      <Alert>
        <Clock3Icon aria-hidden="true" />
        <AlertTitle>This range will be ready after the next refresh</AlertTitle>
        <AlertDescription>
          Today&apos;s limit of new ranges is used up. Reporting data refreshes every 6 hours.
        </AlertDescription>
      </Alert>
    );
  }
  if (summary.delayedSince) {
    return (
      <Alert>
        <TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>Reporting data is delayed</AlertTitle>
        <AlertDescription>
          The last refresh was {summary.delayedSince}. Today&apos;s numbers are still live.
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}

/** The freshness line's words, with the Live dot. */
export function FreshnessWords({ summary, className }: { summary: Extract<FreshnessSummary, { kind: "line" }>; className?: string }) {
  return (
    <span className={className} role="status">
      {summary.live ? (
        <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-primary align-middle" />
      ) : null}
      {summary.label}
    </span>
  );
}

/**
 * One line for a page's panels: "Live" on Today, "Data as of 2:31 PM" for a
 * range that ended before today, "Today live · earlier days as of 2:31 PM"
 * for one that includes today, and the loading, waiting, delayed and failed
 * states of the reporting database. Pass every panel's freshness; the page
 * shows one line.
 */
export function AnalyticsFreshnessLine({ items }: { items: readonly AnalyticsFreshness[] }) {
  const now = useNow();
  const summary = freshnessSummary(items, now);
  if (summary.kind !== "line") return <AnalyticsFreshnessAlert summary={summary} />;
  return (
    <div className="flex flex-col gap-2">
      <AnalyticsFreshnessAlert summary={summary} />
      <p className="text-xs text-muted-foreground">
        <FreshnessWords summary={summary} />
      </p>
    </div>
  );
}
