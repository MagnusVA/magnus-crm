"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
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
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

interface LossAttributionChartProps {
  lossAttribution: {
    admin: number;
    closer: number;
    unknown: number;
    byActor: Array<{
      userId: string;
      actorName: string;
      actorRole: "admin" | "closer" | "unknown";
      count: number;
    }>;
  };
}

const chartConfig = {
  admin: {
    label: "Admin",
    color: "var(--chart-1)",
  },
  closer: {
    label: "Closer",
    color: "var(--chart-2)",
  },
  unknown: {
    label: "Unknown",
    color: "var(--chart-5)",
  },
} satisfies ChartConfig;

function formatRole(role: "admin" | "closer" | "unknown") {
  switch (role) {
    case "admin":
      return "Admin";
    case "closer":
      return "Closer";
    case "unknown":
      return "Unknown";
  }
}

export function LossAttributionChart({
  lossAttribution,
}: LossAttributionChartProps) {
  const totalLosses =
    lossAttribution.admin + lossAttribution.closer + lossAttribution.unknown;

  const chartData = useMemo(
    () => [
      {
        bucket: "Losses",
        admin: lossAttribution.admin,
        closer: lossAttribution.closer,
        unknown: lossAttribution.unknown,
      },
    ],
    [lossAttribution.admin, lossAttribution.closer, lossAttribution.unknown],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin-vs-Closer Loss Attribution</CardTitle>
        <CardDescription>
          Range-filtered lost opportunities grouped by who marked them lost.
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Badge variant="outline">Range</Badge>
          <Badge variant="secondary">{totalLosses.toLocaleString()} losses</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {totalLosses === 0 ? (
          <Empty className="border bg-muted/20 py-12">
            <EmptyHeader>
              <EmptyTitle>No lost opportunities in this range</EmptyTitle>
              <EmptyDescription>
                Choose a wider period to inspect attribution trends.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ChartContainer config={chartConfig} className="h-40 w-full aspect-auto">
              <BarChart
                accessibilityLayer
                data={chartData}
                layout="vertical"
                margin={{ left: 12, right: 12 }}
              >
                <CartesianGrid horizontal={false} />
                <XAxis hide type="number" />
                <YAxis
                  dataKey="bucket"
                  type="category"
                  tickLine={false}
                  axisLine={false}
                />
                <ChartTooltip
                  cursor={false}
                  content={<ChartTooltipContent indicator="line" />}
                />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar
                  dataKey="admin"
                  stackId="loss"
                  fill="var(--color-admin)"
                  radius={[8, 0, 0, 8]}
                />
                <Bar
                  dataKey="closer"
                  stackId="loss"
                  fill="var(--color-closer)"
                />
                <Bar
                  dataKey="unknown"
                  stackId="loss"
                  fill="var(--color-unknown)"
                  radius={[0, 8, 8, 0]}
                />
              </BarChart>
            </ChartContainer>

            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">By actor</p>
                <p className="text-xs text-muted-foreground">
                  Top {Math.min(lossAttribution.byActor.length, 8)} shown
                </p>
              </div>
              <div className="flex flex-col gap-2">
                {lossAttribution.byActor.slice(0, 8).map((actor) => (
                  <div
                    key={actor.userId}
                    className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                  >
                    <div className="min-w-0 flex items-center gap-2">
                      <p className="truncate font-medium">{actor.actorName}</p>
                      <Badge variant="outline">
                        {formatRole(actor.actorRole)}
                      </Badge>
                    </div>
                    <p className="tabular-nums text-sm text-muted-foreground">
                      {actor.count.toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
