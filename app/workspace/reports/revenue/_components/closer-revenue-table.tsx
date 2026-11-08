"use client";

import { useState } from "react";
import { DetailCardFooter, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { getMemberDisplayName, type MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { cn } from "@/lib/utils";
import { COLUMN_HEAD, FIGURE_15, ReportCard, RowsSkeleton, TOTAL_ROW } from "../../_components/report-ui";
import { countWords, dollars, formatCount, shareOf } from "./revenue-format";

// Closers ranked by final revenue in the Phone Closers Table's grammar: one
// ruled table with a muted Total row last. Closers with no deals fold into a
// footer line. Below @lg/closers each row folds to two lines.

type CloserRow = {
  closerId: string;
  closer: MemberAvatarIdentity;
  revenueMinor: number;
  dealCount: number;
  avgDealMinor: number | null;
};

type Totals = { finalRevenueMinor: number; totalDeals: number; avgDealMinor: number | null };

type Figure = { key: string; head: string; value: (row: CloserRow) => string; quiet?: (row: CloserRow) => boolean };

function figures(totalMinor: number): Figure[] {
  return [
    { key: "revenue", head: "Revenue", value: (row) => dollars(row.revenueMinor), quiet: (row) => row.revenueMinor === 0 },
    { key: "share", head: "Share", value: (row) => shareOf(row.revenueMinor, totalMinor), quiet: (row) => row.revenueMinor === 0 },
    { key: "deals", head: "Deals", value: (row) => formatCount(row.dealCount), quiet: (row) => row.dealCount === 0 },
    { key: "avg", head: "Avg deal", value: (row) => (row.avgDealMinor === null ? "—" : dollars(row.avgDealMinor)) },
  ];
}

function foldWords(row: CloserRow, totalMinor: number, isTotal = false) {
  const parts = [countWords(row.dealCount, "deal")];
  if (!isTotal && row.revenueMinor > 0) parts.push(`${shareOf(row.revenueMinor, totalMinor)} of revenue`);
  if (row.avgDealMinor !== null) parts.push(`avg ${dollars(row.avgDealMinor)}`);
  return parts.join(" · ");
}

export function CloserRevenueTable({
  rows,
  totals,
  rangePhrase,
  reloading,
}: {
  rows: CloserRow[] | undefined;
  totals: Totals | undefined;
  rangePhrase: string;
  reloading?: boolean;
}) {
  const [showQuiet, setShowQuiet] = useState(false);
  const active = rows?.filter((row) => row.dealCount > 0 || row.revenueMinor !== 0) ?? [];
  const quiet = rows?.filter((row) => row.dealCount === 0 && row.revenueMinor === 0) ?? [];
  const shown = showQuiet ? [...active, ...quiet] : active;
  const totalMinor = totals?.finalRevenueMinor ?? 0;
  const columns = figures(totalMinor);
  const creditedMinor = rows?.reduce((sum, row) => sum + row.revenueMinor, 0) ?? 0;
  const uncreditedMinor = Math.max(0, totalMinor - creditedMinor);
  const total: CloserRow = {
    closerId: "total",
    closer: { id: "total", name: "Total", source: "system" },
    revenueMinor: totalMinor,
    dealCount: totals?.totalDeals ?? 0,
    avgDealMinor: totals?.avgDealMinor ?? null,
  };
  const uncreditedLine =
    uncreditedMinor > 0 ? <p className="text-[13px] font-normal text-muted-foreground">{dollars(uncreditedMinor)} not credited to a closer</p> : null;

  return (
    <ReportCard
      title="Revenue by closer"
      meta="Ranked by final revenue"
      container="@container/closers"
      reloading={reloading}
      footer={
        quiet.length > 0 ? (
          <DetailCardFooter className="font-normal">
            <span className="text-[13px]">
              {showQuiet
                ? `The last ${formatCount(quiet.length)} had no deals ${rangePhrase}`
                : `${active.length > 0 ? `${formatCount(quiet.length)} more` : formatCount(quiet.length)} ${quiet.length === 1 ? "closer" : "closers"} had no deals ${rangePhrase}`}
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
        ) : null
      }
    >
      {rows === undefined || totals === undefined ? (
        <RowsSkeleton rows={8} label="Loading revenue by closer" />
      ) : rows.length === 0 ? (
        <SectionEmpty title="No closers yet.">Closers appear here once they are on the team.</SectionEmpty>
      ) : shown.length === 0 ? (
        <SectionEmpty title={`No deals for closers ${rangePhrase}.`} />
      ) : (
        <>
          <table className="hidden w-full border-collapse @lg/closers:table">
            <caption className="sr-only">Final revenue by closer, in dollars</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
                  Closer
                </th>
                {columns.map((column, index) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(COLUMN_HEAD, "text-right", index === columns.length - 1 && "pr-4")}
                  >
                    {column.head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.closerId} className="h-11 border-b">
                  <th scope="row" className="max-w-0 truncate py-2 pr-3 pl-4 text-left font-semibold">
                    {getMemberDisplayName(row.closer)}
                  </th>
                  {columns.map((column, index) => (
                    <td
                      key={column.key}
                      className={cn(
                        FIGURE_15,
                        "w-[1%] px-2.5 text-right whitespace-nowrap",
                        index === columns.length - 1 && "pr-4",
                        column.quiet?.(row) && "text-muted-foreground",
                      )}
                    >
                      {column.value(row)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className={cn(TOTAL_ROW, "h-11")}>
                <th scope="row" className="py-2 pr-3 pl-4 text-left">
                  <p>Total</p>
                  {uncreditedLine}
                </th>
                {columns.map((column, index) => (
                  <td
                    key={column.key}
                    className={cn(FIGURE_15, "px-2.5 text-right whitespace-nowrap", index === columns.length - 1 && "pr-4")}
                  >
                    {column.key === "share" ? (totalMinor > 0 ? "100%" : "—") : column.value(total)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>

          <ul aria-label="Final revenue by closer" className="flex flex-col @lg/closers:hidden">
            {[...shown, total].map((row) => {
              const isTotal = row === total;
              return (
                <li key={row.closerId} className={cn("flex flex-col gap-0.5 border-b px-4 py-2.5 last:border-b-0", isTotal && TOTAL_ROW)}>
                  <p className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate font-semibold">{getMemberDisplayName(row.closer)}</span>
                    <span className={cn(FIGURE_15, "shrink-0", !isTotal && row.revenueMinor === 0 && "text-muted-foreground")}>
                      {dollars(row.revenueMinor)}
                    </span>
                  </p>
                  <p className="text-[13px] font-normal text-muted-foreground">{foldWords(row, totalMinor, isTotal)}</p>
                  {isTotal ? uncreditedLine : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </ReportCard>
  );
}
