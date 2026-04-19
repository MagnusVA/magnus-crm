"use client";

import { CircleAlertIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatRate } from "./reviews-report-lib";

export function DisputeRateCard({
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
            Dispute Rate
          </CardTitle>
          <CircleAlertIcon className="size-4 text-destructive" aria-hidden />
        </div>
        <CardDescription>Reviews resolved as disputed in range.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {formatRate(rate)}
        </div>
        <p className="text-xs text-muted-foreground">
          {count.toLocaleString()} disputed of {resolvedCount.toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}
