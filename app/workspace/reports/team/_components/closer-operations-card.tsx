"use client";

import { Fragment } from "react";
import { getMemberDisplayName } from "@/app/workspace/_components/member-avatar";
import { ATTENDANCE_COUNTS_PARTIAL_HELP } from "@/app/workspace/_components/results-recorded";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { cn } from "@/lib/utils";
import { COLUMN_HEAD, FIGURE_15, ReportCard, ReportNote, RowsSkeleton, TOTAL_ROW } from "../../_components/report-ui";
import type { TeamOperationsDimensions } from "./team-report-types";
import { formatCount, formatRate, resultsWords } from "./team-report-formatters";

// Booked-call outcomes per phone closer, the one card the band's filters
// narrow (DESIGN.md, The Phone Closers Table). From @xl/ops one ruled table
// with a Total row; narrower, each closer folds to the name over its counts
// in words.

type Counts = TeamOperationsDimensions["totals"];

type Column = { key: string; head: string; value: (counts: Counts) => string; quietAtZero?: (counts: Counts) => boolean };

const COLUMNS: Column[] = [
  { key: "booked", head: "Booked", value: (c) => formatCount(c.scheduled) },
  { key: "held", head: "Held", value: (c) => formatCount(c.completed) },
  { key: "canceled", head: "Canceled", value: (c) => formatCount(c.canceled), quietAtZero: (c) => c.canceled === 0 },
  { key: "noShows", head: "No-show", value: (c) => formatCount(c.noShows), quietAtZero: (c) => c.noShows === 0 },
  { key: "showRate", head: "Show rate", value: (c) => formatRate(c.showRate) },
  { key: "noShowRate", head: "No-show rate", value: (c) => formatRate(c.noShowRate) },
];

const WORDS: Record<string, string> = {
  booked: "booked",
  held: "held",
  canceled: "canceled",
  noShows: "no-show",
  showRate: "show rate",
  noShowRate: "no-show rate",
};

function CountWords({ counts }: { counts: Counts }) {
  return (
    <p className="text-[13px] text-muted-foreground">
      {COLUMNS.map((column, index) => (
        <Fragment key={column.key}>
          <span className="whitespace-nowrap">
            <span className={cn(FIGURE_15, "text-foreground")}>{column.value(counts)}</span> {WORDS[column.key]}
          </span>
          {index < COLUMNS.length - 1 ? " · " : null}
        </Fragment>
      ))}
    </p>
  );
}

function Figures({ counts, total = false }: { counts: Counts; total?: boolean }) {
  return (
    <>
      {COLUMNS.map((column, index) => (
        <td
          key={column.key}
          className={cn(
            "px-2.5 text-right whitespace-nowrap",
            FIGURE_15,
            index === COLUMNS.length - 1 && "pr-4",
            !total && column.quietAtZero?.(counts) && "text-muted-foreground",
          )}
        >
          {column.value(counts)}
        </td>
      ))}
    </>
  );
}

function OperationsTable({ data }: { data: TeamOperationsDimensions }) {
  const partial = data.attendanceCountsPartial;
  return (
    <>
      <table className="hidden w-full border-collapse @xl/ops:table">
        <caption className="sr-only">Booked-call outcomes by phone closer</caption>
        <thead>
          <tr className="border-b">
            <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
              Phone closer
            </th>
            {COLUMNS.map((column, index) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  COLUMN_HEAD,
                  "text-right",
                  column.key === "noShows" && "whitespace-nowrap",
                  index === COLUMNS.length - 1 && "pr-4",
                )}
              >
                {column.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.closerId} className="border-b">
              <th scope="row" className="py-2 pr-3 pl-4 text-left font-normal">
                <p className="font-semibold">{getMemberDisplayName(row.closer)}</p>
                <p className="text-[13px] text-muted-foreground">{resultsWords(row, partial)}</p>
              </th>
              <Figures counts={row} />
            </tr>
          ))}
          <tr className={TOTAL_ROW}>
            <th scope="row" className="py-2 pr-3 pl-4 text-left">
              <p className="font-semibold">Total</p>
              <p className="text-[13px] font-normal text-muted-foreground">{resultsWords(data.totals, partial)}</p>
            </th>
            <Figures counts={data.totals} total />
          </tr>
        </tbody>
      </table>

      <ul aria-label="Booked-call outcomes by phone closer" className="flex flex-col @xl/ops:hidden">
        {data.rows.map((row) => (
          <li key={row.closerId} className="flex flex-col gap-1 border-b px-4 py-2.5">
            <p className="truncate font-semibold">{getMemberDisplayName(row.closer)}</p>
            <CountWords counts={row} />
          </li>
        ))}
        <li className={cn("flex flex-col gap-1 px-4 py-2.5", TOTAL_ROW)}>
          <p className="font-semibold">Total</p>
          <CountWords counts={data.totals} />
          <p className="text-[13px] font-normal text-muted-foreground">{resultsWords(data.totals, partial)}</p>
        </li>
      </ul>
    </>
  );
}

export function CloserOperationsCard({
  data,
  filtered,
  rangePhrase,
  reloading,
}: {
  data: TeamOperationsDimensions | undefined;
  /** A program, DM team or DM closer filter is on. */
  filtered: boolean;
  rangePhrase: string;
  reloading: boolean;
}) {
  return (
    <ReportCard
      title="Phone closer operations"
      meta={`${filtered ? "Filtered · " : ""}Show rate: held ÷ (held + no-show)`}
      container="@container/ops"
      reloading={reloading}
    >
      {data === undefined ? (
        <RowsSkeleton rows={6} rowHeight="h-[52px]" label="Loading phone closer operations" />
      ) : (
        <>
          {data.truncated ? (
            <ReportNote lead="Capped.">
              This range has more than 8,192 daily rows, or over 2,000 meetings for the chosen DM team or closer. Narrow
              the range for full counts.
            </ReportNote>
          ) : null}
          {data.attendanceCountsPartial && data.rows.length > 0 ? (
            <ReportNote lead="Partial.">{ATTENDANCE_COUNTS_PARTIAL_HELP}</ReportNote>
          ) : null}
          {data.rows.length === 0 ? (
            <SectionEmpty title={`No calls booked with phone closers ${rangePhrase}.`}>
              {filtered ? "Clear the filters above to see every booking." : null}
            </SectionEmpty>
          ) : (
            <OperationsTable data={data} />
          )}
        </>
      )}
    </ReportCard>
  );
}
