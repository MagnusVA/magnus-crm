import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { BarChart3Icon } from "lucide-react";
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
import type { HistogramCounts } from "./meeting-time-report-helpers";
import { sumCounts } from "./meeting-time-report-helpers";

const chartConfig = {
  count: {
    label: "Meetings",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const BUCKET_ORDER = ["0", "1-5", "6-15", "16-30", "30+"] as const;

interface MeetingTimeHistogramCardProps {
  title: string;
  description: string;
  ariaLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  color: string;
  buckets: HistogramCounts;
}

export function MeetingTimeHistogramCard({
  title,
  description,
  ariaLabel,
  emptyTitle,
  emptyDescription,
  color,
  buckets,
}: MeetingTimeHistogramCardProps) {
  const chartData = BUCKET_ORDER.map((bucket) => ({
    bucket,
    count: buckets[bucket],
  }));
  const total = sumCounts(buckets);

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
              className="min-h-[280px] w-full"
              aria-label={ariaLabel}
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
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  allowDecimals={false}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      labelFormatter={(label) => `${label} minute bucket`}
                      formatter={(value) => (
                        <span className="font-medium">
                          {Number(value).toLocaleString()} meeting
                          {Number(value) === 1 ? "" : "s"}
                        </span>
                      )}
                    />
                  }
                />
                <Bar dataKey="count" fill={color} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ChartContainer>

            <p className="text-xs text-muted-foreground">
              {total.toLocaleString()} meeting
              {total === 1 ? "" : "s"} with measurable timing data in this
              distribution.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
