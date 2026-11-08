"use client";

import { useState } from "react";
import { DetailCardFooter, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { getMemberDisplayName, type MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { cn } from "@/lib/utils";
import { COLUMN_HEAD, FIGURE_15, ReportCard, RowsSkeleton, TOTAL_ROW } from "../../_components/report-ui";
import { formatCount } from "./leads-figures";

// Conversions per closer, most first, in the Phone Closers Table's grammar:
// label heads, 15px condensed figures, a muted Total row last. Closers with
// no conversions fold into one footer line.

type CloserRow = { closerId: string; closer: MemberAvatarIdentity; conversions: number };

const share = new Intl.NumberFormat(undefined, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function ConversionByCloserTable({
  byCloser,
  totalConversions,
  rangePhrase,
  reloading,
}: {
  byCloser: CloserRow[] | undefined;
  totalConversions: number | undefined;
  rangePhrase: string;
  reloading?: boolean;
}) {
  const [showQuiet, setShowQuiet] = useState(false);
  const sorted = byCloser && [...byCloser].sort((a, b) => b.conversions - a.conversions);
  const active = sorted?.filter((row) => row.conversions > 0) ?? [];
  const quiet = sorted?.filter((row) => row.conversions === 0) ?? [];
  const shown = showQuiet ? [...active, ...quiet] : active;
  const total = totalConversions ?? 0;

  return (
    <ReportCard
      title="Conversions by closer"
      meta={sorted && active.length > 0 ? "Most first" : undefined}
      container="@container/closers"
      reloading={reloading}
      footer={
        quiet.length > 0 && active.length > 0 ? (
          <DetailCardFooter className="font-normal">
            <span className="text-[13px]">
              {showQuiet
                ? `The last ${formatCount(quiet.length)} converted nobody ${rangePhrase}`
                : `${formatCount(quiet.length)} more closer${quiet.length === 1 ? "" : "s"} converted nobody ${rangePhrase}`}
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
      {sorted === undefined ? (
        <RowsSkeleton rows={6} label="Loading conversions by closer" />
      ) : sorted.length === 0 ? (
        <SectionEmpty title="No closers yet.">Closers appear here once they are on the team.</SectionEmpty>
      ) : shown.length === 0 ? (
        <SectionEmpty title={`No conversions ${rangePhrase}.`} />
      ) : (
        <table className="w-full border-collapse">
          <caption className="sr-only">Conversions by closer, with each closer&apos;s share of the total</caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
                Closer
              </th>
              <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                Conversions
              </th>
              <th scope="col" className={cn(COLUMN_HEAD, "pr-4 text-right")}>
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const quietRow = row.conversions === 0;
              return (
                <tr key={row.closerId} className="h-11 border-b">
                  <th scope="row" className="max-w-0 truncate pr-3 pl-4 text-left font-semibold">
                    {getMemberDisplayName(row.closer)}
                  </th>
                  <td className={cn(FIGURE_15, "w-32 px-2.5 text-right", quietRow && "text-muted-foreground")}>
                    {formatCount(row.conversions)}
                  </td>
                  <td className={cn(FIGURE_15, "w-24 pr-4 pl-2.5 text-right", quietRow && "text-muted-foreground")}>
                    {total > 0 ? share.format(row.conversions / total) : "—"}
                  </td>
                </tr>
              );
            })}
            <tr className={cn("h-11", TOTAL_ROW)}>
              <th scope="row" className="pr-3 pl-4 text-left font-semibold">
                Total
              </th>
              <td className={cn(FIGURE_15, "px-2.5 text-right")}>{formatCount(total)}</td>
              <td className={cn(FIGURE_15, "pr-4 pl-2.5 text-right")}>{total > 0 ? share.format(1) : "—"}</td>
            </tr>
          </tbody>
        </table>
      )}
    </ReportCard>
  );
}
