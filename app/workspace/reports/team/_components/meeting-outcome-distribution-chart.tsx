"use client";

import { useMemo } from "react";
import { Pie, PieChart, Cell } from "recharts";
import { ActivityIcon } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import type { OutcomeKey } from "./team-report-types";

const OUTCOME_META: Record<OutcomeKey, { label: string; color: string }> = {
  sold: { label: "Sold", color: "var(--chart-1)" },
  lost: { label: "Lost", color: "var(--chart-2)" },
  no_show: { label: "No Show", color: "hsl(var(--destructive))" },
  canceled: { label: "Canceled", color: "var(--muted-foreground)" },
  rescheduled: { label: "Rescheduled", color: "var(--chart-3)" },
  dq: { label: "Disqualified", color: "var(--chart-5)" },
  follow_up: { label: "Follow-Up", color: "var(--chart-4)" },
  in_progress: { label: "In Progress", color: "var(--chart-2)" },
  scheduled: { label: "Scheduled", color: "var(--chart-5)" },
};

interface MeetingOutcomeDistributionChartProps {
  outcomeMix: Record<OutcomeKey, number>;
}

export function MeetingOutcomeDistributionChart({
  outcomeMix,
}: MeetingOutcomeDistributionChartProps) {
  const chartData = useMemo(
    () =>
      (Object.entries(OUTCOME_META) as Array<
        [OutcomeKey, (typeof OUTCOME_META)[OutcomeKey]]
      >)
        .map(([key, meta]) => ({
          key,
          label: meta.label,
          count: outcomeMix[key],
          fill: meta.color,
        }))
        .filter((entry) => entry.count > 0),
    [outcomeMix],
  );

  const chartConfig = useMemo(
    () =>
      chartData.reduce<ChartConfig>((config, entry) => {
        config[entry.label] = {
          label: entry.label,
          color: entry.fill,
        };
        return config;
      }, {}),
    [chartData],
  );

  const totalOutcomes = useMemo(
    () => chartData.reduce((sum, entry) => sum + entry.count, 0),
    [chartData],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Meeting Outcome Distribution</CardTitle>
        <CardDescription>
          Outcome mix across completed, canceled, no-show, and rescheduled
          meetings in the selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <Empty className="border-border bg-muted/20">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyTitle>No meeting outcomes yet</EmptyTitle>
              <EmptyDescription>
                Outcome distribution appears once meetings in the selected range
                resolve into trackable statuses.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <ChartContainer
              config={chartConfig}
              className="mx-auto aspect-square max-h-[320px] w-full"
            >
              <PieChart accessibilityLayer>
                <ChartTooltip content={<ChartTooltipContent nameKey="label" />} />
                <Pie
                  data={chartData}
                  dataKey="count"
                  nameKey="label"
                  innerRadius={70}
                  outerRadius={112}
                  strokeWidth={4}
                >
                  {chartData.map((entry) => (
                    <Cell key={entry.key} fill={entry.fill} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>

            <div className="flex flex-col gap-3" aria-label="Outcome legend">
              {chartData.map((entry) => {
                const share =
                  totalOutcomes > 0 ? (entry.count / totalOutcomes) * 100 : 0;

                return (
                  <div
                    key={entry.key}
                    className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: entry.fill }}
                        aria-hidden="true"
                      />
                      <span className="truncate text-sm font-medium">
                        {entry.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{entry.count}</Badge>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {share.toFixed(0)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
