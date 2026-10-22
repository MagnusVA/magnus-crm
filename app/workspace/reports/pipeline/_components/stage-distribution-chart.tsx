"use client";

import { useMemo } from "react";
import { Pie, PieChart, Cell } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import type { DealPosition } from "@/convex/opportunities/stages";

// One colour per position, typed by the position so a new one needs a colour:
// the open stages in order on the chart ramp, Won green, Lost grey.
const POSITION_COLORS: Record<DealPosition, string> = {
  qualified: "var(--chart-1)",
  booked: "var(--chart-2)",
  call_held: "var(--chart-3)",
  follow_up: "var(--chart-4)",
  won: "var(--primary)",
  lost: "var(--muted-foreground)",
};

interface StageDistributionChartProps {
  distribution: Array<{
    position: DealPosition;
    count: number;
  }>;
}

export function StageDistributionChart({
  distribution,
}: StageDistributionChartProps) {
  const chartData = useMemo(
    () =>
      distribution
        .filter((entry) => entry.count > 0)
        .map((entry) => ({
          position: entry.position,
          count: entry.count,
          fill: POSITION_COLORS[entry.position],
        })),
    [distribution],
  );

  const chartConfig = useMemo(() => {
    const config: ChartConfig = {};
    for (const entry of chartData) {
      config[entry.position] = {
        label: dealPositionLabel(entry.position),
        color: entry.fill,
      };
    }
    return config;
  }, [chartData]);

  const isEmpty = chartData.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deal Stage Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            No deals in pipeline
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="mx-auto aspect-square max-h-[300px]">
            <PieChart accessibilityLayer>
              <ChartTooltip content={<ChartTooltipContent nameKey="position" />} />
              <Pie
                data={chartData}
                dataKey="count"
                nameKey="position"
                innerRadius={60}
                outerRadius={100}
              >
                {chartData.map((entry) => (
                  <Cell key={entry.position} fill={entry.fill} />
                ))}
              </Pie>
              <ChartLegend content={<ChartLegendContent nameKey="position" />} />
            </PieChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
