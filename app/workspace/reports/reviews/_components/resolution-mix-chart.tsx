"use client";

import { useMemo } from "react";
import { AlertCircleIcon } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  REPORT_SCAN_CAP,
  RESOLUTION_ACTIONS,
  RESOLUTION_COLORS,
  RESOLUTION_LABELS,
  getShareOfTotal,
  type ResolutionMix,
} from "./reviews-report-lib";

export function ResolutionMixChart({
  resolutionMix,
  resolvedCount,
  unclassified,
  isTruncated,
}: {
  resolutionMix: ResolutionMix;
  resolvedCount: number;
  unclassified: number;
  isTruncated: boolean;
}) {
  const chartConfig = useMemo(() => {
    return RESOLUTION_ACTIONS.reduce<ChartConfig>((config, action) => {
      config[action] = {
        label: RESOLUTION_LABELS[action],
        color: RESOLUTION_COLORS[action],
      };
      return config;
    }, {});
  }, []);

  const chartData = useMemo(
    () => [
      {
        label: "Resolved",
        ...resolutionMix,
      },
    ],
    [resolutionMix],
  );

  const legendRows = RESOLUTION_ACTIONS.map((action) => {
    const count = resolutionMix[action];
    return {
      action,
      count,
      share: getShareOfTotal(count, resolvedCount),
    };
  });

  return (
    <Card className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardAction>
          {isTruncated ? <Badge variant="outline">Capped</Badge> : null}
        </CardAction>
        <CardTitle>Resolution Mix</CardTitle>
        <CardDescription>
          How admins resolved reviews inside the selected date range.
          {isTruncated
            ? ` First ${REPORT_SCAN_CAP.toLocaleString()} resolved reviews shown.`
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {resolvedCount === 0 ? (
          <Empty className="min-h-[250px] border-border/60 bg-muted/10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertCircleIcon />
              </EmptyMedia>
              <EmptyTitle>No resolved reviews in range</EmptyTitle>
              <EmptyDescription>
                Expand the date range to see how review actions were distributed.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ChartContainer
              config={chartConfig}
              className="h-[180px] w-full aspect-auto"
            >
              <BarChart accessibilityLayer data={chartData} layout="vertical">
                <CartesianGrid horizontal={false} />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="label" hide />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => Number(value).toLocaleString()}
                    />
                  }
                />
                {RESOLUTION_ACTIONS.map((action) => (
                  <Bar
                    key={action}
                    dataKey={action}
                    stackId="resolution"
                    fill={`var(--color-${action})`}
                  />
                ))}
              </BarChart>
            </ChartContainer>

            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {legendRows.map(({ action, count, share }) => (
                <div
                  key={action}
                  className="flex items-center justify-between gap-3 rounded-xl border bg-muted/15 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: RESOLUTION_COLORS[action] }}
                      aria-hidden
                    />
                    <span className="text-sm font-medium">
                      {RESOLUTION_LABELS[action]}
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold tabular-nums">
                      {count.toLocaleString()}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {(share * 100).toFixed(1)}%
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {unclassified > 0 ? (
              <p className="text-xs text-muted-foreground">
                {unclassified.toLocaleString()} resolved review
                {unclassified === 1 ? "" : "s"} had no structured
                resolution action recorded.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
