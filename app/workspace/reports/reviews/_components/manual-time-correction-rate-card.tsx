"use client";

import { WrenchIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatRate } from "./reviews-report-lib";

export function ManualTimeCorrectionRateCard({
  rate,
  count,
  resolvedCount,
}: {
  rate: number | null;
  count: number;
  resolvedCount: number;
}) {
  return (
    <Card
      size="sm"
      className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500"
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Manual Time Correction
          </CardTitle>
          <WrenchIcon className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <CardDescription>Admin-entered start/stop corrections.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {formatRate(rate)}
        </div>
        <p className="text-xs text-muted-foreground">
          {count.toLocaleString()} of {resolvedCount.toLocaleString()}{" "}
          resolutions
        </p>
      </CardContent>
    </Card>
  );
}
