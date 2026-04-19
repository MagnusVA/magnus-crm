"use client";

import { formatDistanceToNow } from "date-fns";
import { AlertCircleIcon, ClockIcon, InboxIcon } from "lucide-react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ReviewBacklogSnapshot } from "./reviews-report-lib";
import { REPORT_SCAN_CAP } from "./reviews-report-lib";

export function ReviewBacklogCard({
  backlog,
}: {
  backlog: ReviewBacklogSnapshot;
}) {
  return (
    <Card
      className={cn(
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500",
        backlog.isTruncated && "ring-amber-500/20",
      )}
    >
      <CardHeader className="border-b bg-muted/20">
        <CardAction>
          {backlog.isTruncated ? (
            <Badge variant="outline" className="border-amber-500/30">
              Capped
            </Badge>
          ) : (
            <Badge variant="secondary">Live queue</Badge>
          )}
        </CardAction>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <InboxIcon className="size-4" aria-hidden />
          Pending Reviews
        </div>
        <CardTitle className="text-4xl tracking-tight tabular-nums">
          {backlog.pendingCount.toLocaleString()}
        </CardTitle>
        <CardDescription>
          Current queue size across all unresolved meeting-overrun reviews.
          This section ignores the selected report date range.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 pt-4 md:grid-cols-[1.2fr_0.8fr]">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Measured{" "}
            <span className="font-medium text-foreground">
              {formatDistanceToNow(backlog.measuredAt, { addSuffix: true })}
            </span>
            .
          </p>
          <p className="text-sm text-muted-foreground">
            Use this number to gauge the current admin queue, not historical
            resolution activity.
          </p>
          {backlog.isTruncated && (
            <Alert className="border-amber-500/25 bg-amber-500/5">
              <AlertCircleIcon aria-hidden />
              <AlertDescription>
                Queue size is capped at the first {REPORT_SCAN_CAP.toLocaleString()}{" "}
                pending reviews for performance.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-1">
          <div className="rounded-xl border bg-muted/20 p-3">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Scope
            </p>
            <p className="mt-2 text-sm font-medium">All unresolved reviews</p>
          </div>
          <div className="rounded-xl border bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              <ClockIcon className="size-3.5" aria-hidden />
              Sampling
            </div>
            <p className="mt-2 text-sm font-medium">
              {backlog.isTruncated
                ? `Showing up to ${REPORT_SCAN_CAP.toLocaleString()} rows`
                : "Full live queue counted"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
