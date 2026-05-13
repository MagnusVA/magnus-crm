"use client";

import type { FunctionReturnType } from "convex/server";
import { MessageSquarePlusIcon } from "lucide-react";
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

type ConversionMetrics = FunctionReturnType<
  typeof api.slack.metrics.conversionMetrics
>;

export function SlackQualifiedTotalCard({
  metrics,
}: {
  metrics: ConversionMetrics;
}) {
  return (
    <Card
      size="sm"
      className="h-full border-primary/20 bg-primary/5 ring-1 ring-primary/10"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquarePlusIcon
            className="size-4 text-muted-foreground"
            aria-hidden
          />
          Slack-Qualified
        </CardTitle>
        <CardDescription>Last 30 days</CardDescription>
        <CardAction>
          <Badge variant={metrics.truncated ? "destructive" : "secondary"}>
            {metrics.truncated ? "Partial" : "Live"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="font-mono text-4xl font-bold tabular-nums">
          {metrics.total.toLocaleString()}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {metrics.stillPending.toLocaleString()} pending,{" "}
          {metrics.lost.toLocaleString()} lost
        </p>
      </CardContent>
    </Card>
  );
}
