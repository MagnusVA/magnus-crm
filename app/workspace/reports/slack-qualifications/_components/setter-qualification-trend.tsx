"use client";

import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  AXIS_PROPS,
  ChartLegend,
  ChartSkeleton,
  GRID_PROPS,
  ReportCard,
  ReportNote,
  SINGLE_SERIES,
  seriesColor,
} from "../../_components/report-ui";
import type { SlackQualificationGranularity } from "./business-date-utils";

// Qualification events per period as ink bars, with the team goal as a
// dashed blue line while the report shows every setter.

type Period = { key: string; qualifiedCount: number; expectedTeamCount: number | null };

const GOAL_COLOR = seriesColor(0);

const chartConfig = {
  qualified: { label: "Events", color: SINGLE_SERIES },
  target: { label: "Goal", color: GOAL_COLOR },
} satisfies ChartConfig;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-05" → "Nov 5", "2026-W45" → "Week 45", "2026-11" → "Nov 2026". */
function periodLabel(key: string) {
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (week) return `Week ${Number(week[2])}`;
  const [year, month, day] = key.split("-");
  const name = MONTHS[Number(month) - 1] ?? key;
  return day ? `${name} ${Number(day)}` : `${name} ${year}`;
}

const GROUP_WORDS: Record<SlackQualificationGranularity, string> = { day: "By day", week: "By week", month: "By month" };

export function SetterQualificationTrend({
  periods,
  filteredToSetter,
  setterName,
  granularity,
  eventsTruncated,
  rangePhrase,
  reloading,
}: {
  periods: Period[] | undefined;
  filteredToSetter: boolean;
  setterName: string | null;
  granularity: SlackQualificationGranularity;
  eventsTruncated: boolean;
  rangePhrase: string;
  reloading: boolean;
}) {
  const chartData = (periods ?? []).map((period) => ({
    period: periodLabel(period.key),
    qualified: period.qualifiedCount,
    target: period.expectedTeamCount,
  }));
  // A goal with no events is still an empty range: the empty line says so.
  const hasData = chartData.some((point) => point.qualified > 0);
  const showTarget = !filteredToSetter && chartData.some((point) => point.target !== null);

  return (
    <ReportCard
      title="Qualification events"
      meta={`${filteredToSetter && setterName ? `${setterName} · ` : ""}${GROUP_WORDS[granularity]}${showTarget ? " · against the team goal" : ""}`}
      reloading={reloading}
    >
      {periods === undefined ? (
        <ChartSkeleton height="h-[260px]" label="Loading the qualification trend" />
      ) : (
        <>
          {eventsTruncated ? (
            <ReportNote lead="Capped.">
              Only the first 1,000 qualification events in this range are counted. Narrow the range before relying on
              these totals.
            </ReportNote>
          ) : null}
          {!hasData ? (
            <SectionEmpty title={`No Slack qualifications ${rangePhrase}.`}>
              Counts appear as setters submit qualified leads in Slack.
            </SectionEmpty>
          ) : (
            <>
              <ChartLegend
                items={[
                  { key: "qualified", label: "Qualification events", color: SINGLE_SERIES },
                  ...(showTarget ? [{ key: "target", label: "Team goal", color: GOAL_COLOR }] : []),
                ]}
              />
              <div className="px-2 pb-3">
                <ChartContainer config={chartConfig} className="aspect-auto h-[260px] w-full">
                  <ComposedChart accessibilityLayer data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis dataKey="period" {...AXIS_PROPS} tickMargin={8} minTickGap={16} />
                    <YAxis allowDecimals={false} width={36} {...AXIS_PROPS} />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          formatter={(value, name) => (
                            <div className="flex w-full items-center justify-between gap-4">
                              <span className="text-muted-foreground">{name === "target" ? "Goal" : "Events"}</span>
                              <span className="font-condensed font-semibold tabular-nums">{Number(value).toLocaleString()}</span>
                            </div>
                          )}
                        />
                      }
                    />
                    <Bar dataKey="qualified" fill="var(--color-qualified)" radius={[3, 3, 0, 0]} maxBarSize={56} isAnimationActive={false} />
                    {showTarget ? (
                      <Line
                        type="linear"
                        dataKey="target"
                        stroke="var(--color-target)"
                        strokeWidth={2}
                        strokeDasharray="5 4"
                        dot={chartData.length === 1 ? { r: 3, fill: GOAL_COLOR, strokeWidth: 0 } : false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    ) : null}
                  </ComposedChart>
                </ChartContainer>
              </div>
            </>
          )}
        </>
      )}
    </ReportCard>
  );
}
