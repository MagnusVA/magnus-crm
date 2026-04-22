"use client";

import type { FunctionReturnType } from "convex/server";
import { InfoIcon } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type RevenueMetrics = FunctionReturnType<
  typeof api.reporting.revenue.getRevenueMetrics
>;
type RevenueByOrigin = RevenueMetrics["commissionable"]["byOrigin"];
type RevenueOrigin = keyof RevenueByOrigin;

// Labels are prefixed with "-Logged" to distinguish *who clicked Record* from
// *who is credited*. All five origins land in the commissionable bucket and
// are attributed to the assigned closer for commission — the prefix lets the
// team spot when admins are logging on behalf (Admin-Logged) vs when the
// closer themselves logged (Closer-Logged).
const ORIGIN_META = {
  closer_meeting: {
    label: "Closer-Logged · Meeting",
    color: "var(--chart-1)",
  },
  closer_reminder: {
    label: "Closer-Logged · Reminder",
    color: "var(--chart-2)",
  },
  admin_meeting: {
    label: "Admin-Logged · Meeting",
    color: "var(--chart-3)",
  },
  admin_reminder: {
    label: "Admin-Logged · Reminder",
    color: "var(--chart-4)",
  },
  admin_review_resolution: {
    label: "Admin-Logged · Review",
    color: "var(--chart-5)",
  },
} satisfies Record<RevenueOrigin, { label: string; color: string }>;

const chartConfig = {
  amount: {
    label: "Revenue",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

interface RevenueByOriginChartProps {
  byOrigin: RevenueByOrigin;
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
      amount: byOrigin[origin as RevenueOrigin] / 100,
      fill: meta.color,
    }))
    .filter((entry) => entry.amount > 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-1">
          <CardTitle>Revenue by Origin</CardTitle>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="What do the origin labels mean?"
              >
                <InfoIcon className="size-4 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 text-sm" align="start">
              <p>
                Every bar here counts as commissionable revenue and is
                attributed to the <strong>assigned closer</strong> for
                commission — that does not change based on who logged the
                payment.
              </p>
              <p className="mt-2">
                The prefix tells you <em>who clicked Record</em>:
              </p>
              <ul className="mt-1 list-disc pl-5">
                <li>
                  <strong>Closer-Logged</strong> — the closer themselves
                  recorded the payment from their meeting or reminder.
                </li>
                <li>
                  <strong>Admin-Logged</strong> — an admin recorded the
                  payment on behalf of the closer (from a meeting, reminder,
                  or review resolution). Useful for spotting when admins are
                  picking up the slack.
                </li>
              </ul>
            </PopoverContent>
          </Popover>
        </div>
        <CardDescription>
          Split commissionable final revenue by the workflow that created the payment.
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
