"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatAmountMinor } from "@/lib/format-currency";

interface RevenueTrendPoint {
  periodKey: string;
  revenueMinor: number;
  dealCount: number;
  finalRevenueMinor: number;
  depositRevenueMinor: number;
}

interface RevenueTrendChartProps {
  data: Array<RevenueTrendPoint>;
}

const chartConfig = {
  finalRevenue: {
    label: "Final revenue",
    color: "var(--chart-1)",
  },
  deposits: {
    label: "Deposits",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

function formatYAxis(value: number): string {
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}k`;
  }
  return `$${value}`;
}

export function RevenueTrendChart({ data }: RevenueTrendChartProps) {
  const chartData = data.map((point) => ({
    periodKey: point.periodKey,
    finalRevenue: point.finalRevenueMinor / 100,
    deposits: point.depositRevenueMinor / 100,
  }));

  const totalPoints = chartData.reduce(
    (sum, point) => sum + point.finalRevenue + point.deposits,
    0,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue Trend</CardTitle>
        <CardDescription>
          Final revenue and deposits across the selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 || totalPoints === 0 ? (
          <div className="flex min-h-[260px] items-center justify-center">
            <p className="text-sm text-muted-foreground">
              No revenue data for this period
            </p>
          </div>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="h-[300px] w-full aspect-auto"
          >
            <LineChart accessibilityLayer data={chartData}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="periodKey"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <YAxis
                tickFormatter={formatYAxis}
                tickLine={false}
                axisLine={false}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name, item) => {
                      const label =
                        (item?.payload &&
                          chartConfig[
                            (name as keyof typeof chartConfig) ?? ""
                          ]?.label) ||
                        chartConfig[name as keyof typeof chartConfig]?.label ||
                        name;
                      return (
                        <div className="flex w-full items-center justify-between gap-4">
                          <span className="text-muted-foreground">{label}</span>
                          <span className="font-mono tabular-nums font-medium">
                            {formatAmountMinor(Number(value) * 100, "USD")}
                          </span>
                        </div>
                      );
                    }}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Line
                name="finalRevenue"
                type="monotone"
                dataKey="finalRevenue"
                stroke="var(--color-finalRevenue)"
                strokeWidth={2.5}
                dot={false}
              />
              <Line
                name="deposits"
                type="monotone"
                dataKey="deposits"
                stroke="var(--color-deposits)"
                strokeWidth={2}
                strokeOpacity={0.85}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
