"use client";

import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { ArrowRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { DetailCardFooter, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { cn } from "@/lib/utils";
import { COLUMN_HEAD, FIGURE_15, ReportCard, ReportNote, RowsSkeleton } from "../../_components/report-ui";
import { countWords, dollars, formatCount } from "./revenue-format";

type Matrix = FunctionReturnType<typeof api.reporting.bookedVsSold.getBookedVsSoldMatrix>;

/** Pairs shown before "Show all": the largest by revenue. */
const FIRST_PAIRS = 8;

// Booked program against sold program, a ruled table ranked by payment
// revenue: the booked program over the sold one ("Same program" when it
// didn't change). Below @md/matrix the payment count joins the second line.
export function BookedVsSoldMatrix({
  matrix,
  rangePhrase,
  reloading,
}: {
  matrix: Matrix | undefined;
  rangePhrase: string;
  reloading?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = matrix?.rows ?? [];
  const shown = showAll ? rows : rows.slice(0, FIRST_PAIRS);
  const hidden = rows.length - FIRST_PAIRS;

  return (
    <ReportCard
      title="Booked to sold program"
      meta="Payment revenue by booked program"
      container="@container/matrix"
      reloading={reloading}
      footer={
        hidden > 0 ? (
          <DetailCardFooter className="font-normal">
            <span className="text-[13px]">
              {showAll ? `All ${formatCount(rows.length)} pairs` : `${formatCount(hidden)} smaller ${hidden === 1 ? "pair" : "pairs"}`}
            </span>
            <button
              type="button"
              aria-expanded={showAll}
              className={cn(detailLinkClass, "text-[13px]")}
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? "Show fewer" : "Show all"}
            </button>
          </DetailCardFooter>
        ) : null
      }
    >
      {matrix === undefined ? (
        <RowsSkeleton rows={8} rowHeight="h-[57px]" label="Loading booked to sold programs" />
      ) : rows.length === 0 ? (
        <SectionEmpty title={`No payments ${rangePhrase}.`} />
      ) : (
        <>
          {matrix.truncated ? (
            <ReportNote lead="Capped.">Too many payments in this range, so some are left out.</ReportNote>
          ) : null}
          <table className="w-full border-collapse">
            <caption className="sr-only">Payment revenue by booked and sold program, in dollars</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
                  Booked → sold
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "hidden text-right @md/matrix:table-cell")}>
                  Payments
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "pr-4 text-right")}>
                  Revenue
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const same = row.soldProgramId === row.bookingProgramId && row.soldProgramId !== "unknown";
                return (
                  <tr key={`${row.bookingProgramId}:${row.soldProgramId}`} className="border-b last:border-b-0">
                    <th scope="row" className="max-w-0 py-2 pr-3 pl-4 text-left font-normal">
                      <p className="truncate font-medium" title={row.bookingProgramName}>
                        {row.bookingProgramName}
                      </p>
                      <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                        <ArrowRightIcon aria-label="sold as" className="size-3.5 shrink-0" />
                        <span className={cn("truncate", !same && "text-foreground")} title={row.soldProgramName}>
                          {same ? "Same program" : row.soldProgramName}
                        </span>
                        <span className="shrink-0 whitespace-nowrap @md/matrix:hidden">
                          · {countWords(row.paymentCount, "payment")}
                        </span>
                      </p>
                    </th>
                    <td className={cn(FIGURE_15, "hidden w-[1%] px-2.5 text-right whitespace-nowrap @md/matrix:table-cell")}>
                      {formatCount(row.paymentCount)}
                    </td>
                    <td className={cn(FIGURE_15, "w-[1%] pr-4 pl-2.5 text-right whitespace-nowrap")}>
                      {dollars(row.totalAmountMinor)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </ReportCard>
  );
}
