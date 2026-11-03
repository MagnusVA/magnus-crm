"use client";

import { Fragment, useMemo, useState } from "react";
import { DetailCard, DetailCardFooter, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { getMemberDisplayName } from "@/app/workspace/_components/member-avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCash } from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import { dealsWonWords, formatCloseRate } from "./close-rate";
import {
  isQuietCloser,
  performanceMoneyForCurrency,
  type SalesCloserRow,
  type SalesTeamTotal,
} from "./sales-calls-data";
import { COLUMN_HEAD, FIGURE_15, formatCount, formatRateOrDash, resultsTitle, resultsWords } from "./sales-format";

// Phone closers ranked by revenue in the chosen currency, one ruled table
// with a Total row. Closers with nothing in the range fold into one footer
// line. Below @3xl/closers each row folds to the name and its counts in words.

type Row = SalesCloserRow | SalesTeamTotal;

type Column = {
  key: string;
  head: string;
  value: (row: Row, currency: string) => string;
  /** Slate when the figure is zero and the row is not the total. */
  quietAtZero?: (row: Row, currency: string) => boolean;
};

const COLUMNS: Column[] = [
  { key: "booked", head: "Booked", value: (row) => formatCount(row.booked) },
  {
    key: "canceled",
    head: "Canceled",
   
    value: (row) => formatCount(row.canceled),
    quietAtZero: (row) => row.canceled === 0,
  },
  {
    key: "noShows",
    head: "No-show",
   
    value: (row) => formatCount(row.noShows),
    quietAtZero: (row) => row.noShows === 0,
  },
  { key: "showed", head: "Held", value: (row) => formatCount(row.showed) },
  { key: "showUpRate", head: "Show rate", value: (row) => formatRateOrDash(row.showUpRate) },
  { key: "closeRate", head: "Close rate", value: (row) => formatCloseRate(row) },
  {
    key: "paymentSales",
    head: "Payment sales",
   
    value: (row, currency) => formatCount(performanceMoneyForCurrency(row, currency).paymentSales),
    quietAtZero: (row, currency) => performanceMoneyForCurrency(row, currency).paymentSales === 0,
  },
  {
    key: "revenue",
    head: "Revenue",
   
    value: (row, currency) => formatCash(performanceMoneyForCurrency(row, currency).paymentRevenueMinor, currency),
    quietAtZero: (row, currency) => performanceMoneyForCurrency(row, currency).paymentRevenueMinor === 0,
  },
  {
    key: "avg",
    head: "Avg sale",
   
    value: (row, currency) => {
      const avg = performanceMoneyForCurrency(row, currency).avgPaymentDealMinor;
      return avg === null ? "—" : formatCash(Math.round(avg), currency);
    },
  },
];

function proofLine(row: Row, partial: boolean | undefined) {
  const won = dealsWonWords(row, true);
  return `${resultsWords(row, partial)}${won ? ` · ${won}` : ""}`;
}

/** The phone row's second line: the counts that matter most, in short words. */
function CompactWords({ row, currency, partial }: { row: Row; currency: string; partial?: boolean }) {
  const money = performanceMoneyForCurrency(row, currency);
  const parts = [
    `${formatCount(row.booked)} booked`,
    `${formatCount(row.showed)} held`,
    `${formatCount(row.noShows)} no-show`,
    `${formatRateOrDash(row.showUpRate)} show`,
    `${formatCloseRate(row)} close`,
    `${formatCount(money.paymentSales)} sale${money.paymentSales === 1 ? "" : "s"}`,
  ];
  return (
    <p className="text-[13px] text-muted-foreground" title={resultsTitle(partial)}>
      {(partial ? [...parts, "counts partial"] : parts).map((part, index) => (
        <Fragment key={part}>
          {index > 0 ? " · " : null}
          <span className="whitespace-nowrap">{part}</span>
        </Fragment>
      ))}
    </p>
  );
}

function PhoneRow({ name, row, currency, partial, total }: { name: string; row: Row; currency: string; partial?: boolean; total?: boolean }) {
  const revenue = performanceMoneyForCurrency(row, currency).paymentRevenueMinor;
  return (
    <>
      <div className="flex items-baseline gap-3">
        <p className="min-w-0 flex-1 truncate font-semibold">{name}</p>
        <p className={cn(FIGURE_15, "shrink-0", !total && revenue === 0 && "text-muted-foreground")}>
          {formatCash(revenue, currency)}
        </p>
      </div>
      <CompactWords row={row} currency={currency} partial={partial} />
    </>
  );
}

function TotalProof({
  total,
  partial,
  unattributedMinor,
  currency,
}: {
  total: SalesTeamTotal;
  partial?: boolean;
  unattributedMinor: number;
  currency: string;
}) {
  return (
    <p className="text-[13px] font-normal text-muted-foreground" title={resultsTitle(partial)}>
      {proofLine(total, partial)}
      {unattributedMinor > 0 ? ` · ${formatCash(unattributedMinor, currency)} not credited to a closer` : null}
    </p>
  );
}

function ClosersTable({
  rows,
  total,
  currency,
  partial,
  unattributedMinor,
}: {
  rows: SalesCloserRow[];
  total: SalesTeamTotal;
  currency: string;
  partial?: boolean;
  unattributedMinor: number;
}) {
  return (
    <div className="@container/closers">
      <table className="hidden w-full border-collapse @3xl/closers:table">
        <caption className="sr-only">Sales-call outcomes and payments by phone closer, revenue in {currency}</caption>
        <thead>
          <tr className="border-b">
            <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
              Phone closer
            </th>
            {COLUMNS.map((column, index) => (
              <th
                key={column.key}
                scope="col"
                className={cn(COLUMN_HEAD, "text-right", index === COLUMNS.length - 1 && "pr-4")}
              >
                {column.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.closerId} className="border-b">
              <th scope="row" className="py-2 pr-3 pl-4 text-left font-normal">
                <p className="font-semibold">{getMemberDisplayName(row.avatar)}</p>
                <p className="text-[13px] text-muted-foreground" title={resultsTitle(partial)}>
                  {proofLine(row, partial)}
                </p>
              </th>
              {COLUMNS.map((column, index) => (
                <td
                  key={column.key}
                  className={cn(
                    "px-2.5 text-right whitespace-nowrap",
                    FIGURE_15,
                    index === COLUMNS.length - 1 && "pr-4",
                    column.quietAtZero?.(row, currency) && "text-muted-foreground",
                  )}
                >
                  {column.value(row, currency)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="bg-muted/40">
            <th scope="row" className="py-2 pr-3 pl-4 text-left">
              <p className="font-semibold">Total</p>
              <TotalProof total={total} partial={partial} unattributedMinor={unattributedMinor} currency={currency} />
            </th>
            {COLUMNS.map((column, index) => (
              <td
                key={column.key}
                className={cn("px-2.5 text-right whitespace-nowrap", FIGURE_15, index === COLUMNS.length - 1 && "pr-4")}
              >
                {column.value(total, currency)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      <ul aria-label="Sales-call outcomes and payments by phone closer" className="flex flex-col @3xl/closers:hidden">
        {rows.map((row) => (
          <li key={row.closerId} className="flex flex-col gap-0.5 border-b px-4 py-2.5">
            <PhoneRow name={getMemberDisplayName(row.avatar)} row={row} currency={currency} partial={partial} />
          </li>
        ))}
        <li className="flex flex-col gap-0.5 bg-muted/40 px-4 py-2.5">
          <PhoneRow name="Total" row={total} currency={currency} partial={partial} total />
          {unattributedMinor > 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {formatCash(unattributedMinor, currency)} not credited to a closer
            </p>
          ) : null}
        </li>
      </ul>
    </div>
  );
}

export function PhoneClosersCard({
  rows,
  teamTotal,
  currency,
  attendanceCountsPartial,
  unattributedMinor,
  rangePhrase,
}: {
  rows: SalesCloserRow[] | undefined;
  teamTotal: SalesTeamTotal | undefined;
  currency: string;
  attendanceCountsPartial?: boolean;
  /** Cash in `currency` counted in the band but credited to no closer. */
  unattributedMinor: number;
  /** "today", "this week", "in this range". */
  rangePhrase: string;
}) {
  const [showQuiet, setShowQuiet] = useState(false);
  const ranked = useMemo(
    () =>
      rows &&
      [...rows].sort(
        (left, right) =>
          performanceMoneyForCurrency(right, currency).paymentRevenueMinor -
            performanceMoneyForCurrency(left, currency).paymentRevenueMinor ||
          right.booked - left.booked ||
          left.label.localeCompare(right.label),
      ),
    [currency, rows],
  );
  const active = ranked?.filter((row) => !isQuietCloser(row)) ?? [];
  const quiet = ranked?.filter(isQuietCloser) ?? [];
  const shown = showQuiet ? [...active, ...quiet] : active;

  return (
    <DetailCard
      title="Phone closers"
      meta={`Ranked by revenue in ${currency} · Show rate: held ÷ (held + no-show)`}
      metaClassName="@max-xl:ml-0 @max-xl:basis-full"
      className="@container min-w-0"
    >
      {ranked === undefined || teamTotal === undefined ? (
        <div role="status" aria-label="Loading phone closers" className="flex flex-col">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center gap-4 border-b px-4 py-2.5">
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-52 max-w-full" />
              </div>
              <Skeleton className="hidden h-4 w-[45%] @3xl:block" />
            </div>
          ))}
        </div>
      ) : ranked.length === 0 ? (
        <SectionEmpty title="No phone closers yet.">Closers appear here once they are on the team.</SectionEmpty>
      ) : shown.length === 0 ? (
        <SectionEmpty title={`No calls or payments for phone closers ${rangePhrase}.`} />
      ) : (
        <ClosersTable
          rows={shown}
          total={teamTotal}
          currency={currency}
          partial={attendanceCountsPartial}
          unattributedMinor={unattributedMinor}
        />
      )}
      {quiet.length > 0 ? (
        <DetailCardFooter className="font-normal">
          <span className="text-[13px]">
            {showQuiet
              ? `The last ${formatCount(quiet.length)} had no calls or payments ${rangePhrase}`
              : `${active.length > 0 ? `${formatCount(quiet.length)} more` : formatCount(quiet.length)} phone closer${quiet.length === 1 ? "" : "s"} had no calls or payments ${rangePhrase}`}
          </span>
          <button
            type="button"
            aria-expanded={showQuiet}
            className={cn(detailLinkClass, "text-[13px]")}
            onClick={() => setShowQuiet((value) => !value)}
          >
            {showQuiet ? "Hide them" : "Show them"}
          </button>
        </DetailCardFooter>
      ) : null}
    </DetailCard>
  );
}
