"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { BarChart3Icon } from "lucide-react";

type SetterQualificationTrendProps = {
  periods: Array<{
    key: string;
    qualifiedCount: number;
    expectedTeamCount: number | null;
  }>;
  filteredToSetter: boolean;
};

const chartConfig = {
  qualified: {
    label: "Qualification events",
    color: "var(--chart-1)",
  },
  target: {
    label: "Target",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

export function SetterQualificationTrend({
  periods,
  filteredToSetter,
}: SetterQualificationTrendProps) {
  const chartData = periods.map((period) => ({
    period: period.key,
    qualified: period.qualifiedCount,
    target: period.expectedTeamCount,
  }));
  const hasData = chartData.some(
    (point) => point.qualified > 0 || (point.target ?? 0) > 0,
  );
  const showTarget =
    !filteredToSetter && chartData.some((point) => point.target !== null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Qualification Event Trend</CardTitle>
        <CardDescription>
          {filteredToSetter
            ? "Selected setter events bucketed by Honduras 1am business day."
            : "Team qualification events bucketed against the shared daily goal."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <Empty className="min-h-[260px] border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BarChart3Icon />
              </EmptyMedia>
              <EmptyTitle>No Slack qualification events in this range.</EmptyTitle>
              <EmptyDescription>
                Counts will appear after setters submit qualified leads through
                Slack.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="h-[320px] w-full aspect-auto"
          >
            <ComposedChart accessibilityLayer data={chartData}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="period"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">
                          {name === "target" ? "Target" : "Events"}
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {Number(value).toLocaleString()}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Bar
                dataKey="qualified"
                fill="var(--color-qualified)"
                radius={[4, 4, 0, 0]}
              />
              {showTarget ? (
                <Line
                  type="monotone"
                  dataKey="target"
                  stroke="var(--color-target)"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={false}
                  connectNulls
                />
              ) : null}
            </ComposedChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
