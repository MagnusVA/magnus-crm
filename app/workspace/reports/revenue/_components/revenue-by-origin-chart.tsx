"use client";

import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
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

const ORIGIN_META = {
  closer_meeting: {
    label: "Closer · Meeting",
    color: "var(--chart-1)",
  },
  closer_reminder: {
    label: "Closer · Reminder",
    color: "var(--chart-2)",
  },
  admin_meeting: {
    label: "Admin · Meeting",
    color: "var(--chart-3)",
  },
  customer_flow: {
    label: "Customer Flow",
    color: "var(--chart-4)",
  },
  unknown: {
    label: "Legacy / Unknown",
    color: "var(--chart-5)",
  },
} as const;

const chartConfig = {
  amount: {
    label: "Revenue",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

interface RevenueByOriginChartProps {
  byOrigin: Record<keyof typeof ORIGIN_META, number>;
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function RevenueByOriginChart({
  byOrigin,
}: RevenueByOriginChartProps) {
  const chartData = Object.entries(ORIGIN_META)
    .map(([origin, meta]) => ({
      origin,
      label: meta.label,
      amount: byOrigin[origin as keyof typeof ORIGIN_META] / 100,
      fill: meta.color,
    }))
    .filter((entry) => entry.amount > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue by Origin</CardTitle>
        <CardDescription>
          Split revenue by the flow that created each payment record.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="flex min-h-[260px] items-center justify-center">
            <p className="text-sm text-muted-foreground">
              No attributed revenue in this period
            </p>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[260px] w-full aspect-auto">
            <BarChart
              accessibilityLayer
              data={chartData}
              layout="vertical"
              margin={{ left: 12, right: 12 }}
            >
              <CartesianGrid horizontal={false} />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `$${Number(value).toLocaleString()}`}
              />
              <YAxis
                dataKey="label"
                type="category"
                tickLine={false}
                axisLine={false}
                width={120}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    formatter={(value) => formatCurrency(Number(value))}
                  />
                }
              />
              <Bar dataKey="amount" radius={[0, 8, 8, 0]}>
                {chartData.map((entry) => (
                  <Cell key={entry.origin} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
