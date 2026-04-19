"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { BarChart3Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRate, sumCounts } from "./meeting-time-report-helpers";

interface SourceSplitChartProps {
  title: string;
  description: string;
  ariaLabel: string;
  counts: Record<string, number>;
  labels: Record<string, string>;
  colors: Record<string, string>;
  emptyTitle: string;
  emptyDescription: string;
}

export function SourceSplitChart({
  title,
  description,
  ariaLabel,
  counts,
  labels,
  colors,
  emptyTitle,
  emptyDescription,
}: SourceSplitChartProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const chartData = useMemo(
    () =>
      Object.keys(labels).map((key) => ({
        key,
        label: labels[key],
        count: counts[key] ?? 0,
        fill: colors[key],
      })),
    [colors, counts, labels],
  );
  const total = sumCounts(counts);

  const chartConfig = useMemo(() => {
    const config: ChartConfig = {};

    for (const item of chartData) {
      config[item.key] = {
        label: item.label,
        color: item.fill,
      };
    }

    return config;
  }, [chartData]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {total === 0 ? (
          <Empty className="min-h-[280px] border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BarChart3Icon />
              </EmptyMedia>
              <EmptyTitle>{emptyTitle}</EmptyTitle>
              <EmptyDescription>{emptyDescription}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ChartContainer
              config={chartConfig}
              className="min-h-[240px] w-full"
              aria-label={ariaLabel}
            >
              <BarChart accessibilityLayer data={chartData}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  allowDecimals={false}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      labelFormatter={(_label, payload) =>
                        payload?.[0]?.payload?.label ?? null
                      }
                      formatter={(value, _name, item) => (
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">
                            {Number(value).toLocaleString()} meeting
                            {Number(value) === 1 ? "" : "s"}
                          </span>
                          <span className="text-muted-foreground">
                            {formatRate(
                              total > 0 ? Number(item.payload?.count) / total : null,
                            )}{" "}
                            of range
                          </span>
                        </div>
                      )}
                    />
                  }
                />
                <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                  {chartData.map((item) => (
                    <Cell
                      key={item.key}
                      fill={item.fill}
                      fillOpacity={
                        activeKey === null || activeKey === item.key ? 1 : 0.35
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>

            <ul className="grid gap-2" aria-label={`${title} legend`}>
              {chartData.map((item) => {
                const isActive = activeKey === item.key;
                const share = total > 0 ? item.count / total : null;

                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      aria-pressed={isActive}
                      onClick={() =>
                        setActiveKey((current) =>
                          current === item.key ? null : item.key,
                        )
                      }
                      onFocus={() => setActiveKey(item.key)}
                      onBlur={() =>
                        setActiveKey((current) =>
                          current === item.key ? null : current,
                        )
                      }
                      onMouseEnter={() => setActiveKey(item.key)}
                      onMouseLeave={() =>
                        setActiveKey((current) =>
                          current === item.key ? null : current,
                        )
                      }
                      className={cn(
                        "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors",
                        isActive ? "bg-muted" : "bg-background hover:bg-muted/50",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="size-2.5 rounded-full"
                          style={{ backgroundColor: item.fill }}
                          aria-hidden
                        />
                        <span className="text-sm font-medium">{item.label}</span>
                      </span>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {item.count.toLocaleString()} · {formatRate(share)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
