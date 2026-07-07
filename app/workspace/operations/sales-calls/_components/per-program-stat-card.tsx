"use client";

import { useMemo, useState } from "react";
import { ChartColumnIcon, ChartPieIcon, TableIcon } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { OverviewHelpTooltip } from "@/app/workspace/_components/overview-help-tooltip";
import { formatAmountMinor } from "@/lib/format-currency";

export type PerProgramRow = {
  /** `tenantPrograms` id as a string, or null for meetings with no program. */
  programId: string | null;
  label: string;
  calls: number;
  showed: number;
  paymentSales: number;
  paymentRevenueMinor: number;
};

type ProgramView = "bar" | "pie" | "table";

const CHART_COLOR_COUNT = 5;
const BAR_ROW_HEIGHT = 44;
const MIN_CHART_HEIGHT = 160;
const Y_AXIS_TICK_MAX_CHARS = 16;

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const compactCurrencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const VIEW_OPTIONS: Array<{
  value: ProgramView;
  label: string;
  tooltip: string;
  icon: typeof ChartColumnIcon;
}> = [
  {
    value: "bar",
    label: "Bar chart",
    tooltip: "Payment revenue per program as bars.",
    icon: ChartColumnIcon,
  },
  {
    value: "pie",
    label: "Pie chart",
    tooltip: "Each program's share of payment revenue (or calls when no revenue).",
    icon: ChartPieIcon,
  },
  {
    value: "table",
    label: "Table",
    tooltip: "Calls, showed, payment sales, and revenue per program.",
    icon: TableIcon,
  },
];

type ProgramDatum = PerProgramRow & { key: string; fill: string };

function TooltipMetricRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium text-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

function ProgramTooltipBody({ datum }: { datum: ProgramDatum }) {
  return (
    <div className="flex min-w-[10rem] flex-col gap-1">
      <span className="font-medium text-foreground">{datum.label}</span>
      <TooltipMetricRow
        label="Revenue"
        value={formatAmountMinor(datum.paymentRevenueMinor, "USD")}
      />
      <TooltipMetricRow label="Calls" value={numberFormatter.format(datum.calls)} />
      <TooltipMetricRow
        label="Showed"
        value={numberFormatter.format(datum.showed)}
      />
      <TooltipMetricRow
        label="Payment sales"
        value={numberFormatter.format(datum.paymentSales)}
      />
    </div>
  );
}

/**
 * Shared tooltip item renderer for the bar and pie views — one payload item
 * per hover, so the "formatter" renders the full metric block (revenue, calls,
 * showed, payment sales) for the hovered program.
 */
function programTooltipFormatter(
  _value: unknown,
  _name: unknown,
  item: { payload?: { payload?: ProgramDatum } & ProgramDatum } | undefined,
) {
  const datum = item?.payload?.payload ?? item?.payload;
  if (!datum) return null;
  return <ProgramTooltipBody datum={datum} />;
}

function truncateTick(value: string) {
  return value.length > Y_AXIS_TICK_MAX_CHARS
    ? `${value.slice(0, Y_AXIS_TICK_MAX_CHARS - 1)}…`
    : value;
}

/**
 * "Per Program Statistic" card for the Phone Sales Ops page: one dataset
 * (getSalesCallsDashboard.perProgram) with a bar chart / pie chart / table
 * toggle. View selection is local component state, not URL state.
 */
export function PerProgramStatCard({
  data,
  rangeLabel,
}: {
  data: PerProgramRow[] | undefined;
  rangeLabel: string;
}) {
  const [view, setView] = useState<ProgramView>("bar");

  const chartData = useMemo<ProgramDatum[]>(
    () =>
      (data ?? []).map((row, index) => ({
        ...row,
        key: row.programId ?? "no-program",
        fill: `var(--chart-${(index % CHART_COLOR_COUNT) + 1})`,
      })),
    [data],
  );

  const totalRevenueMinor = useMemo(
    () => chartData.reduce((sum, row) => sum + row.paymentRevenueMinor, 0),
    [chartData],
  );
  // Pie shares fall back to call counts when the range has no revenue at all,
  // so the breakdown stays meaningful for pre-payment pipelines.
  const pieUsesRevenue = totalRevenueMinor > 0;

  const chartConfig = useMemo<ChartConfig>(() => {
    const config: ChartConfig = {
      paymentRevenueMinor: { label: "Revenue" },
      calls: { label: "Calls" },
    };
    for (const row of chartData) {
      config[row.label] = { label: row.label, color: row.fill };
    }
    return config;
  }, [chartData]);

  const barChartHeight = Math.max(
    MIN_CHART_HEIGHT,
    chartData.length * BAR_ROW_HEIGHT,
  );

  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>
          <OverviewHelpTooltip
            description="Sales-call and payment performance broken down by program. Calls and showed use the meeting's booked program; payment sales and revenue use the payment's own program."
            label="Per Program Statistic"
          >
            Per Program Statistic
          </OverviewHelpTooltip>
        </CardTitle>
        <CardDescription className="text-xs">
          Calls, show-ups, payment sales, and revenue per program —{" "}
          {rangeLabel}.
        </CardDescription>
        <CardAction>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={view}
            onValueChange={(value) => {
              if (value) setView(value as ProgramView);
            }}
            aria-label="Per-program view"
          >
            {VIEW_OPTIONS.map(({ value, label, tooltip, icon: Icon }) => (
              <Tooltip key={value}>
                <TooltipTrigger asChild>
                  <ToggleGroupItem value={value} aria-label={label}>
                    <Icon aria-hidden="true" />
                  </ToggleGroupItem>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-pretty" side="bottom">
                  {tooltip}
                </TooltipContent>
              </Tooltip>
            ))}
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        {data === undefined ? (
          <Skeleton
            className="h-[280px] w-full"
            role="status"
            aria-label="Loading per-program statistics"
          />
        ) : chartData.length === 0 ? (
          <Empty className="min-h-[200px] border p-4">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChartPieIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No program activity</EmptyTitle>
              <EmptyDescription>
                No sales calls or payments in this range.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : view === "bar" ? (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto w-full"
            style={{ height: barChartHeight }}
          >
            <BarChart
              accessibilityLayer
              data={chartData}
              layout="vertical"
              margin={{ left: 0, right: 56 }}
            >
              <CartesianGrid horizontal={false} />
              <YAxis
                dataKey="label"
                type="category"
                tickLine={false}
                tickMargin={8}
                axisLine={false}
                width={116}
                tickFormatter={truncateTick}
              />
              <XAxis dataKey="paymentRevenueMinor" type="number" hide />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    hideLabel
                    formatter={programTooltipFormatter}
                  />
                }
              />
              <Bar dataKey="paymentRevenueMinor" radius={4} maxBarSize={28}>
                {chartData.map((entry) => (
                  <Cell key={entry.key} fill={entry.fill} />
                ))}
                <LabelList
                  dataKey="paymentRevenueMinor"
                  position="right"
                  offset={8}
                  className="fill-foreground"
                  fontSize={12}
                  formatter={(value) =>
                    typeof value === "number"
                      ? compactCurrencyFormatter.format(value / 100)
                      : value
                  }
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        ) : view === "pie" ? (
          <div className="flex flex-col gap-2">
            <ChartContainer
              config={chartConfig}
              className="mx-auto aspect-square w-full max-h-[300px]"
            >
              <PieChart accessibilityLayer>
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      hideLabel
                      nameKey="label"
                      formatter={programTooltipFormatter}
                    />
                  }
                />
                <Pie
                  data={chartData}
                  dataKey={pieUsesRevenue ? "paymentRevenueMinor" : "calls"}
                  nameKey="label"
                  innerRadius={60}
                  outerRadius={100}
                >
                  {chartData.map((entry) => (
                    <Cell key={entry.key} fill={entry.fill} />
                  ))}
                </Pie>
                <ChartLegend content={<ChartLegendContent nameKey="label" />} />
              </PieChart>
            </ChartContainer>
            {!pieUsesRevenue ? (
              <p className="text-center text-xs text-muted-foreground">
                No payment revenue in this range — slices show each
                program&apos;s share of calls instead.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[32%] font-semibold text-foreground/80">
                    Program
                  </TableHead>
                  <TableHead className="text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description="Meetings scheduled in the range whose booked program is this program."
                      label="Calls"
                      triggerClassName="w-full justify-end"
                    >
                      Calls
                    </OverviewHelpTooltip>
                  </TableHead>
                  <TableHead className="text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description="Calls marked completed for this program in the range."
                      label="Showed"
                      triggerClassName="w-full justify-end"
                    >
                      Showed
                    </OverviewHelpTooltip>
                  </TableHead>
                  <TableHead className="text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description="Commissionable final payments recorded against this program in the range."
                      label="Payment Sales"
                      triggerClassName="w-full justify-end"
                    >
                      Payment Sales
                    </OverviewHelpTooltip>
                  </TableHead>
                  <TableHead className="w-[18%] text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description="Sum of those payments' amounts."
                      label="Revenue"
                      triggerClassName="w-full justify-end"
                    >
                      Revenue
                    </OverviewHelpTooltip>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {chartData.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell className="max-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="size-2.5 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: row.fill }}
                        />
                        <span className="truncate text-sm font-medium">
                          {row.label}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {numberFormatter.format(row.calls)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {numberFormatter.format(row.showed)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {numberFormatter.format(row.paymentSales)}
                    </TableCell>
                    <TableCell className="text-right text-sm font-semibold tabular-nums">
                      {formatAmountMinor(row.paymentRevenueMinor, "USD")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
