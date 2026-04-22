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
  commissionableFinalMinor: number;
  commissionableDepositMinor: number;
  nonCommissionableFinalMinor: number;
  nonCommissionableDepositMinor: number;
}

interface RevenueTrendChartProps {
  data: Array<RevenueTrendPoint>;
}

const chartConfig = {
  commissionableFinal: {
    label: "Commissionable Final",
    color: "var(--chart-1)",
  },
  commissionableDeposit: {
    label: "Commissionable Deposit",
    color: "var(--chart-2)",
  },
  nonCommissionableFinal: {
    label: "Post-Conversion Final",
    color: "var(--chart-3)",
  },
  nonCommissionableDeposit: {
    label: "Post-Conversion Deposit",
    color: "var(--chart-4)",
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
    commissionableFinal: point.commissionableFinalMinor / 100,
    commissionableDeposit: point.commissionableDepositMinor / 100,
    nonCommissionableFinal: point.nonCommissionableFinalMinor / 100,
    nonCommissionableDeposit: point.nonCommissionableDepositMinor / 100,
  }));

  const totalPoints = chartData.reduce(
    (sum, point) =>
      sum +
      point.commissionableFinal +
      point.commissionableDeposit +
      point.nonCommissionableFinal +
      point.nonCommissionableDeposit,
    0,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue Trend</CardTitle>
        <CardDescription>
          Commissionable and post-conversion revenue plotted separately across
          the selected range.
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
                name="commissionableFinal"
                type="monotone"
                dataKey="commissionableFinal"
                stroke="var(--color-commissionableFinal)"
                strokeWidth={2.5}
                dot={false}
              />
              <Line
                name="commissionableDeposit"
                type="monotone"
                dataKey="commissionableDeposit"
                stroke="var(--color-commissionableDeposit)"
                strokeWidth={2}
                strokeOpacity={0.85}
                dot={false}
              />
              <Line
                name="nonCommissionableFinal"
                type="monotone"
                dataKey="nonCommissionableFinal"
                stroke="var(--color-nonCommissionableFinal)"
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
              />
              <Line
                name="nonCommissionableDeposit"
                type="monotone"
                dataKey="nonCommissionableDeposit"
                stroke="var(--color-nonCommissionableDeposit)"
                strokeWidth={1.75}
                strokeDasharray="3 3"
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
