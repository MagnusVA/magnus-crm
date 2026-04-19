"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
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

interface NoShowSourceSplitChartProps {
  split: {
    closer: number;
    calendly_webhook: number;
    none: number;
  };
}

const chartConfig = {
  count: {
    label: "No-shows",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

export function NoShowSourceSplitChart({
  split,
}: NoShowSourceSplitChartProps) {
  const data = useMemo(
    () => [
      {
        source: "Closer",
        count: split.closer,
        fill: "var(--chart-1)",
      },
      {
        source: "Webhook",
        count: split.calendly_webhook,
        fill: "var(--chart-3)",
      },
      {
        source: "Unset",
        count: split.none,
        fill: "var(--chart-5)",
      },
    ],
    [split.calendly_webhook, split.closer, split.none],
  );

  const total = data.reduce((sum, row) => sum + row.count, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>No-Show Source Split</CardTitle>
        <CardDescription>
          Range-filtered no-show records by recording source.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">Range</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <Empty className="border bg-muted/20 py-12">
            <EmptyHeader>
              <EmptyTitle>No no-shows in this range</EmptyTitle>
              <EmptyDescription>
                Widen the range to inspect where no-show records are coming
                from.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ChartContainer config={chartConfig} className="h-64 w-full aspect-auto">
            <BarChart accessibilityLayer data={data} margin={{ left: 16 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="source"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <YAxis hide />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent />}
              />
              <Bar dataKey="count" radius={8}>
                {data.map((entry) => (
                  <Cell key={entry.source} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
