"use client";

import { useMemo } from "react";
import { MessageSquareIcon } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
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
import {
  CLOSER_RESPONSE_COLORS,
  CLOSER_RESPONSE_KEYS,
  CLOSER_RESPONSE_LABELS,
  getShareOfTotal,
  type CloserResponseMix,
} from "./reviews-report-lib";

export function CloserResponseMixChart({
  closerResponseMix,
}: {
  closerResponseMix: CloserResponseMix;
}) {
  const chartConfig = useMemo(() => {
    return CLOSER_RESPONSE_KEYS.reduce<ChartConfig>((config, key) => {
      config[key] = {
        label: CLOSER_RESPONSE_LABELS[key],
        color: CLOSER_RESPONSE_COLORS[key],
      };
      return config;
    }, {});
  }, []);

  const chartData = CLOSER_RESPONSE_KEYS.map((key) => ({
    key,
    label: CLOSER_RESPONSE_LABELS[key],
    count: closerResponseMix[key],
  }));

  const totalResponses = chartData.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <Card className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>Closer Response Mix</CardTitle>
        <CardDescription>
          No response means the review was resolved without a closer reply
          recorded.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {totalResponses === 0 ? (
          <Empty className="min-h-[250px] border-border/60 bg-muted/10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareIcon />
              </EmptyMedia>
              <EmptyTitle>No closer response data</EmptyTitle>
              <EmptyDescription>
                This range does not include any resolved reviews with response
                metadata.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ChartContainer
              config={chartConfig}
              className="h-[220px] w-full aspect-auto"
            >
              <BarChart
                accessibilityLayer
                data={chartData}
                layout="vertical"
                margin={{ left: 6, right: 12, top: 4, bottom: 4 }}
              >
                <CartesianGrid horizontal={false} />
                <XAxis
                  type="number"
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  dataKey="label"
                  type="category"
                  width={128}
                  tickLine={false}
                  axisLine={false}
                />
                <Bar dataKey="count" radius={8}>
                  {chartData.map((entry) => (
                    <Cell
                      key={entry.key}
                      fill={`var(--color-${entry.key})`}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>

            <div className="grid gap-2 sm:grid-cols-3">
              {chartData.map((entry) => (
                <div
                  key={entry.key}
                  className="rounded-xl border bg-muted/15 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="size-2.5 rounded-full"
                      style={{
                        backgroundColor: CLOSER_RESPONSE_COLORS[entry.key],
                      }}
                      aria-hidden
                    />
                    <span className="text-sm font-medium">{entry.label}</span>
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-3">
                    <span className="text-lg font-semibold tabular-nums">
                      {entry.count.toLocaleString()}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {(getShareOfTotal(entry.count, totalResponses) * 100).toFixed(
                        1,
                      )}
                      %
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
