"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

interface FieldAnswerDistributionProps {
  distribution: {
    fieldKey: string;
    totalResponses: number;
    distinctAnswers: number;
    distribution: Array<{
      answer: string;
      count: number;
      percent: number;
    }>;
    isTruncated: boolean;
  };
}

const chartConfig = {
  count: {
    label: "Responses",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

export function FieldAnswerDistribution({
  distribution,
}: FieldAnswerDistributionProps) {
  if (distribution.distribution.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No responses recorded for this field
      </p>
    );
  }

  const sorted = [...distribution.distribution].sort(
    (a, b) => b.count - a.count,
  );

  return (
    <div className="space-y-3">
      <p className="text-sm">
        <span className="font-semibold">
          {distribution.totalResponses.toLocaleString()}
        </span>{" "}
        responses across{" "}
        <span className="font-semibold">
          {distribution.distinctAnswers.toLocaleString()}
        </span>{" "}
        unique answers
      </p>

      <ChartContainer config={chartConfig} className="min-h-[250px] w-full">
        <BarChart accessibilityLayer data={sorted}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="answer"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(value: string) =>
              value.length > 20 ? `${value.slice(0, 17)}...` : value
            }
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            allowDecimals={false}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name, item) => (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">
                      {typeof value === "number"
                        ? value.toLocaleString()
                        : String(value)}{" "}
                      responses
                    </span>
                    <span className="text-muted-foreground">
                      {item.payload?.percent !== undefined
                        ? `${item.payload.percent.toFixed(1)}%`
                        : ""}
                    </span>
                  </div>
                )}
              />
            }
          />
          <Bar
            dataKey="count"
            fill="var(--color-count)"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ChartContainer>

      {distribution.isTruncated && (
        <p className="text-xs text-muted-foreground">
          Response data has been capped due to volume. Showing the most common
          answers.
        </p>
      )}
    </div>
  );
}
