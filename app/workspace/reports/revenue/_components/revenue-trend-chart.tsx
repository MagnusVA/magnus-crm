"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  AXIS_PROPS,
  ChartLegend,
  ChartSkeleton,
  FIGURE_15,
  GRID_PROPS,
  ReportCard,
  SERIES_COLORS,
} from "../../_components/report-ui";
import { dollars } from "./revenue-format";

type RevenueTrendPoint = {
  periodKey: string;
  finalRevenueMinor: number;
  depositRevenueMinor: number;
};

// Final revenue and deposits are the page's two measures: blue and teal,
// the first two series colours.
const chartConfig = {
  finalRevenue: { label: "Final revenue", color: SERIES_COLORS[0] },
  deposits: { label: "Deposits", color: SERIES_COLORS[1] },
} satisfies ChartConfig;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08" → "Aug 2026", "2026-W35" → "Week 35", "2026-10-03" → "Oct 3". */
function periodLabel(key: string) {
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (week) return `Week ${Number(week[2])}`;
  const [year, month, day] = key.split("-");
  const name = MONTHS[Number(month) - 1] ?? key;
  return day ? `${name} ${Number(day)}` : `${name} ${year}`;
}

function axisDollars(value: number) {
  return value >= 1000 ? `$${Math.round(value / 1000)}k` : `$${value}`;
}

export function RevenueTrendChart({
  data,
  rangePhrase,
  reloading,
}: {
  data: RevenueTrendPoint[] | undefined;
  rangePhrase: string;
  reloading?: boolean;
}) {
  const chartData =
    data?.map((point) => ({
      period: periodLabel(point.periodKey),
      finalRevenue: point.finalRevenueMinor / 100,
      deposits: point.depositRevenueMinor / 100,
    })) ?? [];
  const hasRevenue = chartData.some((point) => point.finalRevenue > 0 || point.deposits > 0);
  // One or two periods draw no visible line, so their points get dots.
  const dots = chartData.length <= 3;

  return (
    <ReportCard title="Revenue trend" reloading={reloading}>
      {data === undefined ? (
        <ChartSkeleton height="h-[272px]" label="Loading the revenue trend" />
      ) : !hasRevenue ? (
        <SectionEmpty title={`No revenue ${rangePhrase}.`} />
      ) : (
        <>
          <ChartLegend
            items={[
              { key: "final", label: chartConfig.finalRevenue.label, color: chartConfig.finalRevenue.color },
              { key: "deposits", label: chartConfig.deposits.label, color: chartConfig.deposits.color },
            ]}
          />
          <div className="px-2 pb-3">
            <ChartContainer config={chartConfig} className="aspect-auto h-[240px] w-full">
              <LineChart accessibilityLayer data={chartData} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis dataKey="period" {...AXIS_PROPS} tickMargin={8} minTickGap={24} />
                <YAxis {...AXIS_PROPS} width={52} tickFormatter={axisDollars} />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value, name) => (
                        <div className="flex w-full items-center justify-between gap-4">
                          <span className="text-muted-foreground">
                            {chartConfig[name as keyof typeof chartConfig]?.label ?? name}
                          </span>
                          <span className={FIGURE_15}>{dollars(Number(value) * 100)}</span>
                        </div>
                      )}
                    />
                  }
                />
                <Line
                  name="finalRevenue"
                  type="monotone"
                  dataKey="finalRevenue"
                  stroke="var(--color-finalRevenue)"
                  strokeWidth={2.5}
                  dot={dots}
                />
                <Line
                  name="deposits"
                  type="monotone"
                  dataKey="deposits"
                  stroke="var(--color-deposits)"
                  strokeWidth={2}
                  dot={dots}
                />
              </LineChart>
            </ChartContainer>
          </div>
        </>
      )}
    </ReportCard>
  );
}
