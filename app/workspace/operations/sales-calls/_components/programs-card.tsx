"use client";

import { useMemo, useState } from "react";
import { Cell, Pie, PieChart } from "recharts";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatCash } from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import { dealsWonWords, formatCloseRate } from "./close-rate";
import { performanceMoneyForCurrency, type SalesProgramRow } from "./sales-calls-data";
import { COLUMN_HEAD, FIGURE_15, formatCount } from "./sales-format";

// Programs: calls, held calls, close rate and payments per program, seen as
// bars, a pie or a table. Bars and the pie measure revenue in the chosen
// currency, or calls when the range has no revenue at all.

type ProgramView = "bars" | "pie" | "table";

const VIEWS: ReadonlyArray<{ value: ProgramView; label: string }> = [
  { value: "bars", label: "Bars" },
  { value: "pie", label: "Pie" },
  { value: "table", label: "Table" },
];

const CHART_COLOR_COUNT = 5;

type ProgramDatum = SalesProgramRow & {
  key: string;
  paymentSales: number;
  paymentRevenueMinor: number;
  measure: number;
  fill: string;
};

const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });

function activityWords(row: ProgramDatum) {
  return `${formatCount(row.calls)} call${row.calls === 1 ? "" : "s"} · ${formatCount(row.showed)} held · ${formatCount(row.paymentSales)} payment sale${row.paymentSales === 1 ? "" : "s"}`;
}

function measureText(row: ProgramDatum, byRevenue: boolean, currency: string) {
  return byRevenue ? formatCash(row.paymentRevenueMinor, currency) : `${formatCount(row.calls)} call${row.calls === 1 ? "" : "s"}`;
}

function FallbackNote({ phrase }: { phrase: string }) {
  return (
    <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">
      No payments {phrase}, so programs are measured by calls.
    </p>
  );
}

function BarsView({ rows, byRevenue, currency }: { rows: ProgramDatum[]; byRevenue: boolean; currency: string }) {
  const max = Math.max(...rows.map((row) => row.measure), 0);
  return (
    <ul className="flex flex-col" aria-label={byRevenue ? `Final cash in ${currency} by program` : "Calls by program"}>
      {rows.map((row) => (
        <li
          key={row.key}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-b px-4 py-2 last:border-b-0 @lg/programs:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]"
        >
          <div className="min-w-0">
            <p className="truncate font-medium">{row.label}</p>
            <p className="truncate text-[13px] text-muted-foreground">{activityWords(row)}</p>
          </div>
          <div aria-hidden="true" className="order-last col-span-2 h-2 overflow-hidden rounded-[3px] bg-muted @lg/programs:order-none @lg/programs:col-span-1">
            <div
              className="h-full rounded-[3px] bg-foreground/75"
              style={{ width: max > 0 ? `${Math.max((row.measure / max) * 100, row.measure > 0 ? 1.5 : 0)}%` : 0 }}
            />
          </div>
          <p className={cn(FIGURE_15, "text-right", row.measure === 0 && "text-muted-foreground")}>
            {measureText(row, byRevenue, currency)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function PieView({ rows, byRevenue, currency }: { rows: ProgramDatum[]; byRevenue: boolean; currency: string }) {
  const total = rows.reduce((sum, row) => sum + row.measure, 0);
  const config = useMemo<ChartConfig>(
    () => Object.fromEntries(rows.map((row) => [row.key, { label: row.label, color: row.fill }])),
    [rows],
  );
  return (
    <div className="flex flex-col items-center gap-2 py-3 @lg/programs:flex-row @lg/programs:items-start">
      <ChartContainer config={config} className="aspect-square w-44 shrink-0 @lg/programs:ml-4">
        <PieChart>
          <Pie data={rows} dataKey="measure" nameKey="label" innerRadius={52} outerRadius={84} strokeWidth={2} isAnimationActive={false}>
            {rows.map((row) => (
              <Cell key={row.key} fill={row.fill} className="stroke-card" />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <ul className="flex w-full min-w-0 flex-col" aria-label={byRevenue ? `Share of final cash in ${currency}` : "Share of calls"}>
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2.5 border-b px-4 py-2 last:border-b-0">
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.fill }} />
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            <span className={cn(FIGURE_15, "w-12 text-right text-muted-foreground")}>
              {total > 0 ? percent.format(row.measure / total) : "—"}
            </span>
            <span className={cn(FIGURE_15, "w-24 text-right")}>{measureText(row, byRevenue, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TableView({ rows, currency }: { rows: ProgramDatum[]; currency: string }) {
  return (
    <table className="w-full border-collapse">
      <caption className="sr-only">Sales calls and payments by program, revenue in {currency}</caption>
      <thead>
        <tr className="border-b">
          <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>Program</th>
          <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>Calls</th>
          <th scope="col" className={cn(COLUMN_HEAD, "hidden text-right @lg/programs:table-cell")}>Held</th>
          <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>Close rate</th>
          <th scope="col" className={cn(COLUMN_HEAD, "hidden text-right @lg/programs:table-cell")}>Payment sales</th>
          <th scope="col" className={cn(COLUMN_HEAD, "pr-4 text-right")}>Final cash</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const won = dealsWonWords(row, true);
          return (
            <tr key={row.key} className="border-b last:border-b-0">
              <th scope="row" className="py-2 pr-3 pl-4 text-left font-normal">
                <p className="font-medium">{row.label}</p>
                {won ? <p className="text-[13px] text-muted-foreground">{won}</p> : null}
                <p className="text-[13px] text-muted-foreground @lg/programs:hidden">
                  {formatCount(row.showed)} held · {formatCount(row.paymentSales)} payment sales
                </p>
              </th>
              <td className={cn(FIGURE_15, "px-2.5 text-right")}>{formatCount(row.calls)}</td>
              <td className={cn(FIGURE_15, "hidden px-2.5 text-right @lg/programs:table-cell")}>{formatCount(row.showed)}</td>
              <td className={cn(FIGURE_15, "px-2.5 text-right")}>{formatCloseRate(row)}</td>
              <td
                className={cn(
                  FIGURE_15,
                  "hidden px-2.5 text-right @lg/programs:table-cell",
                  row.paymentSales === 0 && "text-muted-foreground",
                )}
              >
                {formatCount(row.paymentSales)}
              </td>
              <td className={cn(FIGURE_15, "pr-4 pl-2.5 text-right whitespace-nowrap", row.paymentRevenueMinor === 0 && "text-muted-foreground")}>
                {formatCash(row.paymentRevenueMinor, currency)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function ProgramsCard({
  data,
  currency,
  rangePhrase,
}: {
  data: SalesProgramRow[] | undefined;
  currency: string;
  /** "today", "this week", "in this range". */
  rangePhrase: string;
}) {
  const [view, setView] = useState<ProgramView>("bars");
  const rows = useMemo(() => {
    const withMoney = (data ?? []).map((row, index) => {
      const money = performanceMoneyForCurrency(row, currency);
      return {
        ...row,
        key: row.programId ?? "no-program",
        paymentSales: money.paymentSales,
        paymentRevenueMinor: money.paymentRevenueMinor,
        fill: `var(--chart-${(index % CHART_COLOR_COUNT) + 1})`,
      };
    });
    const byRevenue = withMoney.some((row) => row.paymentRevenueMinor > 0);
    const measured: ProgramDatum[] = withMoney.map((row) => ({
      ...row,
      measure: byRevenue ? row.paymentRevenueMinor : row.calls,
    }));
    measured.sort((left, right) => right.measure - left.measure || left.label.localeCompare(right.label));
    return { byRevenue, measured };
  }, [currency, data]);

  return (
    <DetailCard
      title="Programs"
      meta={
        <ToggleGroup
          type="single"
          size="sm"
          value={view}
          onValueChange={(next) => {
            if (next) setView(next as ProgramView);
          }}
          aria-label="Show programs as"
          className="h-[30px] rounded-[7px] bg-muted p-0.5"
        >
          {VIEWS.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className="h-full rounded-[5px]! px-2.5 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
      className="min-w-0"
    >
      <div className="@container/programs">
        {data === undefined ? (
          <div role="status" aria-label="Loading programs" className="flex flex-col">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex items-center gap-4 border-b px-4 py-2.5 last:border-b-0">
                <div className="flex w-40 flex-col gap-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-36" />
                </div>
                <Skeleton className="h-2 flex-1" />
                <Skeleton className="h-4 w-14" />
              </div>
            ))}
          </div>
        ) : rows.measured.length === 0 ? (
          <SectionEmpty title={`No calls or payments for any program ${rangePhrase}.`} />
        ) : (
          <>
            {!rows.byRevenue && view !== "table" ? <FallbackNote phrase={rangePhrase} /> : null}
            {view === "bars" ? (
              <BarsView rows={rows.measured} byRevenue={rows.byRevenue} currency={currency} />
            ) : view === "pie" ? (
              <PieView rows={rows.measured} byRevenue={rows.byRevenue} currency={currency} />
            ) : (
              <TableView rows={rows.measured} currency={currency} />
            )}
          </>
        )}
      </div>
    </DetailCard>
  );
}
