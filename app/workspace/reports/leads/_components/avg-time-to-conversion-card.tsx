"use client";

import { TimerIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface AvgTimeToConversionCardProps {
  avgMs: number | null;
  sampleCount: number;
}

function formatDurationMs(ms: number) {
  const totalHours = ms / 3_600_000;
  if (totalHours < 24) {
    return `${totalHours.toFixed(1)}h`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = Math.round(totalHours - days * 24);
  return `${days}d ${hours}h`;
}

export function AvgTimeToConversionCard({
  avgMs,
  sampleCount,
}: AvgTimeToConversionCardProps) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-muted-foreground">
          <TimerIcon className="size-4" />
          Avg Time to Conversion
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">
          {avgMs === null ? "\u2014" : formatDurationMs(avgMs)}
        </div>
        <p className="text-xs text-muted-foreground">
          Across {sampleCount.toLocaleString()} conversions in range
        </p>
      </CardContent>
    </Card>
  );
}
