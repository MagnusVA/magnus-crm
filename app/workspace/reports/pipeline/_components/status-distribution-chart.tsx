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

const STATUS_COLORS: Record<string, string> = {
  scheduled: "var(--chart-1)",
  in_progress: "var(--chart-2)",
  follow_up_scheduled: "var(--chart-3)",
  reschedule_link_sent: "var(--chart-3)",
  payment_received: "var(--chart-4)",
  lost: "var(--chart-5)",
  canceled: "var(--muted)",
  no_show: "var(--destructive)",
};

function formatStatus(status: string): string {
  return status
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface StatusDistributionChartProps {
  distribution: Array<{
    status: string;
    count: number;
  }>;
}

export function StatusDistributionChart({
  distribution,
}: StatusDistributionChartProps) {
  const chartData = useMemo(
    () =>
      distribution
        .filter((entry) => entry.count > 0)
        .map((entry) => ({
          status: formatStatus(entry.status),
          count: entry.count,
          fill: STATUS_COLORS[entry.status] || "var(--muted)",
        })),
    [distribution],
  );

  const chartConfig = useMemo(() => {
    const config: ChartConfig = {};
    for (const entry of chartData) {
      config[entry.status] = {
        label: entry.status,
        color: entry.fill,
      };
    }
    return config;
  }, [chartData]);

  const isEmpty = chartData.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Status Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            No opportunities in pipeline
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="mx-auto aspect-square max-h-[300px]">
            <PieChart accessibilityLayer>
              <ChartTooltip content={<ChartTooltipContent nameKey="status" />} />
              <Pie
                data={chartData}
                dataKey="count"
                nameKey="status"
                innerRadius={60}
                outerRadius={100}
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.fill} />
                ))}
              </Pie>
              <ChartLegend content={<ChartLegendContent nameKey="status" />} />
            </PieChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
