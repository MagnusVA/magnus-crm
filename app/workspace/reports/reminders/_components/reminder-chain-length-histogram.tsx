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
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  formatCount,
  type ReminderReportData,
} from "./reminders-report-config";

const chartConfig = {
  opportunities: {
    label: "Opportunities",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

interface ReminderChainLengthHistogramProps {
  chainLengthHistogram: ReminderReportData["chainLengthHistogram"];
  opportunitiesWithReminderChains: ReminderReportData["opportunitiesWithReminderChains"];
}

export function ReminderChainLengthHistogram({
  chainLengthHistogram,
  opportunitiesWithReminderChains,
}: ReminderChainLengthHistogramProps) {
  const chartData = chainLengthHistogram.map((entry) => ({
    ...entry,
    opportunities: entry.count,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reminder Chain Length</CardTitle>
        <CardDescription>
          {formatCount(opportunitiesWithReminderChains)} opportunities produced
          manual reminder chains inside this date window.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={chartConfig}
          className="min-h-[280px] w-full aspect-auto"
        >
          <BarChart accessibilityLayer data={chartData}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="bucket"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => `Chain length: ${value}`}
                  formatter={(value) =>
                    `${Number(value).toLocaleString()} opportunities`
                  }
                />
              }
            />
            <Bar
              dataKey="opportunities"
              fill="var(--color-opportunities)"
              radius={[8, 8, 0, 0]}
              maxBarSize={64}
            />
          </BarChart>
        </ChartContainer>
        <p className="mt-3 text-xs text-muted-foreground">
          Buckets count manual reminders created on the same opportunity within
          the selected range.
        </p>
      </CardContent>
    </Card>
  );
}
