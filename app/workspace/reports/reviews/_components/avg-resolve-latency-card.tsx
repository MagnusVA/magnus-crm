"use client";

import { ClockIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDurationMs } from "./reviews-report-lib";

export function AvgResolveLatencyCard({
  latencyMs,
}: {
  latencyMs: number | null;
}) {
  return (
    <Card
      size="sm"
      className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500"
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Avg Resolve Latency
          </CardTitle>
          <ClockIcon className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <CardDescription>From review creation to admin resolution.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {formatDurationMs(latencyMs)}
        </div>
        <p className="text-xs text-muted-foreground">
          Adaptive units from minutes through days
        </p>
      </CardContent>
    </Card>
  );
}
