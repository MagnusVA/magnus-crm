"use client";

import { CircleXIcon, Clock3Icon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/hooks/use-now";
import type { AnalyticsFreshness } from "./use-analytics-report";

/** Older than this, the reporting data is called delayed (§8.2). */
const DELAYED_AFTER_MS = 8 * 60 * 60 * 1000;

function formatAsOf(timestamp: number, now: number) {
  const sameDay = new Date(timestamp).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(timestamp),
  );
}

type WarehouseFreshness = Extract<AnalyticsFreshness, { source: "warehouse" }>;

/**
 * One line for a page's panels: "Live" on Today, "Data as of 2:31 PM"
 * otherwise, and the loading, waiting, delayed and failed states of the
 * reporting database. Pass every panel's freshness; the page shows one line.
 */
export function AnalyticsFreshnessLine({ items }: { items: readonly AnalyticsFreshness[] }) {
  const now = useNow();
  const warehouse = items.filter((item): item is WarehouseFreshness => item.source === "warehouse");

  if (warehouse.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" />
        Live
      </p>
    );
  }

  const failed = warehouse.filter((item) => item.state === "failed");
  if (failed.length > 0) {
    return (
      <Alert variant="destructive">
        <CircleXIcon aria-hidden="true" />
        <AlertTitle>This range couldn&apos;t be loaded</AlertTitle>
        <AlertDescription>{failed[0].errorMessage ?? "The reporting database didn't answer."}</AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={() => failed.forEach((item) => item.retry())}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  if (warehouse.some((item) => item.state === "loading" || (item.state === "pending" && !item.refreshing))) {
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

  if (warehouse.some((item) => item.state === "queued")) {
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

  const asOf = Math.min(...warehouse.map((item) => item.asOf ?? Number.POSITIVE_INFINITY));
  const refreshing = warehouse.some((item) => item.refreshing);
  const label = Number.isFinite(asOf) ? `Data as of ${formatAsOf(asOf, now)}` : "Data from the last sync";
  return (
    <div className="flex flex-col gap-2">
      {Number.isFinite(asOf) && now - asOf > DELAYED_AFTER_MS ? (
        <Alert>
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>Reporting data is delayed</AlertTitle>
          <AlertDescription>
            The last refresh was {formatAsOf(asOf, now)}. Today&apos;s numbers are still live.
          </AlertDescription>
        </Alert>
      ) : null}
      <p className="text-xs text-muted-foreground" role="status">
        {label}
        {refreshing ? " · Refreshing" : ""}
      </p>
    </div>
  );
}
