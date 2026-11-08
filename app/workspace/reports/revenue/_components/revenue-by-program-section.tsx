"use client";

import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { BarList, ReportCard, RowsSkeleton } from "../../_components/report-ui";
import { countWords, dollars } from "./revenue-format";

type ProgramRow = FunctionReturnType<typeof api.reporting.revenue.getRevenueMetrics>["revenue"]["byProgram"][number];

/** Final revenue per payment program, largest first, with its deposits in the meta line. */
export function RevenueByProgramSection({
  rows,
  rangePhrase,
  reloading,
}: {
  rows: ReadonlyArray<ProgramRow> | undefined;
  rangePhrase: string;
  reloading?: boolean;
}) {
  const ranked = rows
    ? [...rows].sort(
        (left, right) =>
          right.finalRevenueMinor - left.finalRevenueMinor || right.depositRevenueMinor - left.depositRevenueMinor,
      )
    : undefined;

  return (
    <ReportCard title="Revenue by payment program" meta="Final revenue" reloading={reloading}>
      {ranked === undefined ? (
        <RowsSkeleton rows={4} rowHeight="h-[52px]" label="Loading revenue by payment program" />
      ) : ranked.length === 0 ? (
        <SectionEmpty title={`No payments ${rangePhrase}.`} />
      ) : (
        <BarList
          label="Final revenue by payment program"
          rows={ranked.map((row) => ({
            key: row.programId ?? row.programName,
            label: row.programName,
            meta:
              row.depositRevenueMinor > 0
                ? `${countWords(row.paymentCount, "payment")} · ${dollars(row.depositRevenueMinor)} in deposits`
                : countWords(row.paymentCount, "payment"),
            value: row.finalRevenueMinor,
            display: dollars(row.finalRevenueMinor),
          }))}
        />
      )}
    </ReportCard>
  );
}
