"use client";

import { getMemberDisplayName } from "@/app/workspace/_components/member-avatar";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { COLUMN_HEAD, FIGURE_15, ReportCard, RowsSkeleton, TOTAL_ROW } from "@/app/workspace/reports/_components/report-ui";
import { cn } from "@/lib/utils";
import { formatCount, formatPercent, type ReminderReportData } from "./reminders-report-config";

// Reminders per closer in the Phone Closers Table's grammar: label heads,
// 15px condensed figures right-aligned, zeros in slate, the muted Total row
// last. Below @xl of the card each closer is two lines, the counts in words.

type Row = {
  key: string;
  name: string;
  created: number;
  completed: number;
  untagged: number;
  completionRate: number | null;
  paid: number;
};

function rowsOf(data: ReminderReportData): { closers: Row[]; total: Row } {
  return {
    closers: data.perCloser.map((row) => ({
      key: row.closerId,
      name: getMemberDisplayName(row.closer),
      created: row.created,
      completed: row.completed,
      untagged: row.completedWithoutOutcomeCount,
      completionRate: row.completionRate,
      paid: row.paymentReceivedCount,
    })),
    total: {
      key: "total",
      name: "Total",
      created: data.totalCreated,
      completed: data.totalCompleted,
      untagged: data.completedWithoutOutcomeCount,
      completionRate: data.completionRate,
      paid: data.outcomeMix.payment_received,
    },
  };
}

const quiet = (value: number, total: boolean) => !total && value === 0 && "text-muted-foreground";

function UntaggedLine({ row }: { row: Row }) {
  return row.untagged > 0 ? (
    <p className="text-[13px] font-normal text-muted-foreground">{formatCount(row.untagged)} without an outcome</p>
  ) : null;
}

function TableRow({ row, total = false }: { row: Row; total?: boolean }) {
  const cell = cn("px-2.5 text-right whitespace-nowrap", FIGURE_15);
  return (
    <tr className={cn("h-11 border-b last:border-b-0", total && TOTAL_ROW)}>
      <th scope="row" className="py-2 pr-3 pl-4 text-left font-normal">
        <p className="truncate font-semibold">{row.name}</p>
        <UntaggedLine row={row} />
      </th>
      <td className={cn(cell, quiet(row.created, total))}>{formatCount(row.created)}</td>
      <td className={cn(cell, quiet(row.completed, total))}>{formatCount(row.completed)}</td>
      <td className={cn(cell, row.completionRate === null && "text-muted-foreground")}>{formatPercent(row.completionRate)}</td>
      <td className={cn(cell, "pr-4", quiet(row.paid, total))}>{formatCount(row.paid)}</td>
    </tr>
  );
}

function FoldedRow({ row, total = false }: { row: Row; total?: boolean }) {
  const figure = "font-condensed text-[14px] font-semibold text-foreground tabular-nums";
  return (
    <li className={cn("flex flex-col gap-0.5 border-b px-4 py-2.5 last:border-b-0", total && TOTAL_ROW)}>
      <p className="truncate font-semibold">{row.name}</p>
      <p className="text-[13px] font-normal text-muted-foreground">
        <span className="whitespace-nowrap">
          <span className={figure}>{formatCount(row.created)}</span> created
        </span>
        {" · "}
        <span className="whitespace-nowrap">
          <span className={figure}>{formatCount(row.completed)}</span> completed
        </span>
        {" · "}
        <span className="whitespace-nowrap">
          <span className={figure}>{formatPercent(row.completionRate)}</span> completion
        </span>
        {" · "}
        <span className="whitespace-nowrap">
          <span className={figure}>{formatCount(row.paid)}</span> paid
        </span>
      </p>
      <UntaggedLine row={row} />
    </li>
  );
}

export function PerCloserReminderConversionTable({
  data,
  reloading,
}: {
  data: ReminderReportData | undefined;
  reloading: boolean;
}) {
  const rows = data ? rowsOf(data) : null;
  return (
    <ReportCard title="Closers" meta="Ranked by payments received" container="@container/closers" reloading={reloading}>
      {rows === null ? (
        <RowsSkeleton rows={6} rowHeight="h-12" label="Loading closers" />
      ) : (
        <>
          <table className="hidden w-full table-fixed border-collapse @xl/closers:table">
            <caption className="sr-only">Manual reminders by closer</caption>
            <colgroup>
              <col />
              <col className="w-[5.5rem]" />
              <col className="w-[6.5rem]" />
              <col className="w-[6.5rem]" />
              <col className="w-[6rem]" />
            </colgroup>
            <thead>
              <tr className="border-b">
                <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
                  Closer
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                  Created
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                  Completed
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                  <HelpTip tip="Completed ÷ created.">Completion</HelpTip>
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "pr-4 text-right")}>
                  <HelpTip tip="Reminders completed with Payment received.">Paid</HelpTip>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.closers.map((row) => (
                <TableRow key={row.key} row={row} />
              ))}
              <TableRow row={rows.total} total />
            </tbody>
          </table>
          <ul aria-label="Manual reminders by closer" className="flex flex-col @xl/closers:hidden">
            {rows.closers.map((row) => (
              <FoldedRow key={row.key} row={row} />
            ))}
            <FoldedRow row={rows.total} total />
          </ul>
        </>
      )}
    </ReportCard>
  );
}
