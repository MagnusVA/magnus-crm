"use client";

import type { FunctionReturnType } from "convex/server";
import { CircleGaugeIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

type ConversionMetrics = FunctionReturnType<
  typeof api.slack.metrics.conversionMetrics
>;

export function SlackConversionRatioCard({
  metrics,
}: {
  metrics: ConversionMetrics;
}) {
  const percent =
    metrics.ratio === null ? null : Math.round(metrics.ratio * 100);
  const progressValue = percent ?? 0;
  const ariaLabel =
    percent === null
      ? "No Slack-qualified conversion data for the last 30 days"
      : `${percent}% Slack-qualified conversion rate`;

  return (
    <Card size="sm" className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleGaugeIcon
            className="size-4 text-muted-foreground"
            aria-hidden
          />
          Conversion Ratio
        </CardTitle>
        <CardDescription>Booked from unique Slack opportunities</CardDescription>
        <CardAction>
          <Badge variant="outline">30d</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div
          className="font-mono text-4xl font-bold tabular-nums"
          aria-label={ariaLabel}
        >
          {percent === null ? "-" : `${percent}%`}
        </div>
        <Progress
          className="mt-3"
          value={progressValue}
          aria-label={ariaLabel}
        />
        <p className="mt-2 text-sm text-muted-foreground">
          {metrics.booked.toLocaleString()} of{" "}
          {metrics.uniqueOpportunityCount.toLocaleString()} unique opportunities
          booked
        </p>
      </CardContent>
    </Card>
  );
}
