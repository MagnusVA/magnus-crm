"use client";

import { AlertTriangleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

export type PhoneSalesStats = {
  scheduled: number;
  completed: number;
  canceled: number;
  noShows: number;
  won: number;
  showRate: number | null;
  isPartial: boolean;
};

function formatPercent(value: number | null) {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function PhoneSalesStatCards({
  stats,
}: {
  stats?: PhoneSalesStats;
}) {
  if (!stats) {
    return (
      <div
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
        role="status"
        aria-label="Loading phone sales stats"
      >
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {stats.isPartial ? (
        <Alert>
          <AlertTriangleIcon />
          <AlertTitle>Stats may be partial</AlertTitle>
          <AlertDescription>
            The selected period returned the current rollup cap. Narrow the
            period or primary filter before using these counts operationally.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Metric label="Booked" value={stats.scheduled} />
        <Metric label="Completed" value={stats.completed} />
        <Metric label="Canceled" value={stats.canceled} />
        <Metric label="No-shows" value={stats.noShows} />
        <Metric label="Won" value={stats.won} />
        <Metric label="Show rate" value={formatPercent(stats.showRate)} />
      </div>
    </div>
  );
}
