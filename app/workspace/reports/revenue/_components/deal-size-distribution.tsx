"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface DealSizeDistributionProps {
  distribution: {
    under500: { count: number; label: string };
    to2k: { count: number; label: string };
    to5k: { count: number; label: string };
    to10k: { count: number; label: string };
    over10k: { count: number; label: string };
  };
}

const chartConfig = {
  count: {
    label: "Deals",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const BUCKET_ORDER = ["under500", "to2k", "to5k", "to10k", "over10k"] as const;

export function DealSizeDistribution({
  distribution,
}: DealSizeDistributionProps) {
  const chartData = BUCKET_ORDER.map((key) => ({
    range: distribution[key].label,
    count: distribution[key].count,
  }));

  const hasData = chartData.some((d) => d.count > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deal Size Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <div className="flex min-h-[250px] items-center justify-center">
            <p className="text-sm text-muted-foreground">
              No deals recorded in this period
            </p>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="min-h-[250px] w-full">
            <BarChart accessibilityLayer data={chartData}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="range"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <YAxis
                tickFormatter={(value: number) => Math.floor(value).toString()}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar
                dataKey="count"
                fill="var(--color-count)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
