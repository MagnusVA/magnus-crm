"use client";

import { Fragment } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { DetailCard, DetailCardFooter } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { MemberAvatar, getMemberDisplayName } from "@/app/workspace/_components/member-avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { figureClass, formatCount, formatShare, headClass, reloadingClass } from "./lead-gen-format";

// Resparks per specialist: the raw leads they captured, the stalled people
// they resparked, and what came of it. Definitions sit in the footer in
// words; caps are said above the rows.

type ResparkReport = FunctionReturnType<typeof api.leadGen.resparkReports.listResparkPerformance>;
type ResparkRow = ResparkReport["rows"][number];

type Column = {
  key: string;
  head: string;
  word: string;
  value: (row: ResparkRow) => number | null;
  share?: boolean;
};

const COLUMNS: Column[] = [
  { key: "raw", head: "Raw leads", word: "raw leads", value: (row) => row.rawLeads },
  { key: "resparks", head: "Resparks", word: "resparks", value: (row) => row.resparks },
  { key: "entries", head: "Entries", word: "entries", value: (row) => row.entries },
  { key: "naf", head: "Not a fit", word: "not a fit", value: (row) => row.notAFit },
  { key: "nafShare", head: "Not a fit share", word: "not a fit share", value: (row) => row.notAFitShare, share: true },
  { key: "booked", head: "Resparked, then booked", word: "resparked, then booked", value: (row) => row.resparkedThenBooked },
];

function display(column: Column, value: number | null) {
  if (value === null) return "—";
  return column.share ? formatShare(value) : formatCount(value);
}

function Words({ row }: { row: ResparkRow }) {
  return (
    <p className="text-[13px] text-muted-foreground">
      {COLUMNS.map((column, index) => (
        <Fragment key={column.key}>
          <span className="whitespace-nowrap">
            <span className={cn(figureClass, "text-foreground")}>{display(column, column.value(row))}</span> {column.word}
          </span>
          {index < COLUMNS.length - 1 ? " · " : null}
        </Fragment>
      ))}
    </p>
  );
}

function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">
      <span className="font-medium text-foreground">{title}</span> {children}
    </p>
  );
}

function ResparkSkeleton() {
  return (
    <div role="status" aria-label="Loading respark" className="flex flex-col">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex h-11 items-center gap-2.5 border-b px-4 last:border-b-0">
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="ml-auto h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** Nobody captured, resparked or ruled anyone out: a quiet day, not a table of zeros. */
function isQuiet(rows: ResparkRow[]) {
  return rows.every(
    (row) => (row.rawLeads ?? 0) === 0 && row.resparks === 0 && row.notAFit === 0 && row.resparkedThenBooked === 0,
  );
}

export function ResparkSection({
  report,
  rangePhrase,
  reloading,
}: {
  report: ResparkReport | undefined;
  /** "today", "this week", "in this range". */
  rangePhrase: string;
  reloading: boolean;
}) {
  const quiet = report !== undefined && (report.rows.length === 0 || isQuiet(report.rows));
  return (
    <DetailCard title="Respark" meta="Entries = raw leads + resparks" className="@container/respark min-w-0">
      <div aria-busy={reloading} className={reloadingClass(reloading)}>
        {report === undefined ? (
          <ResparkSkeleton />
        ) : quiet ? (
          <SectionEmpty title={`No raw leads or resparks ${rangePhrase}.`} />
        ) : (
          <>
            {report.rawLeadsCapped ? (
              <Note title="Raw leads unavailable.">
                This range holds more daily stats than one live read covers, so Raw leads and Entries read “—”. Choose a
                shorter range.
              </Note>
            ) : null}
            {report.bookedCapped ? (
              <Note title="Partial.">
                Resparked, then booked counts what one live read covers. Choose a shorter range for the full count.
              </Note>
            ) : null}
            {report.capped ? <Note title="Partial.">Showing the specialists one live read covers, up to 500.</Note> : null}

            <table className="hidden w-full table-fixed border-collapse @2xl/respark:table">
              <caption className="sr-only">Respark by specialist</caption>
              <colgroup>
                <col className="w-[26%]" />
              </colgroup>
              <thead>
                <tr className="border-b">
                  <th scope="col" className={headClass("left")}>Specialist</th>
                  {COLUMNS.map((column, index) => (
                    <th key={column.key} scope="col" className={cn(headClass(), index === COLUMNS.length - 1 && "pr-4")}>
                      {column.head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.workerId} className="border-b last:border-b-0">
                    <th scope="row" className="max-w-0 py-2 pr-3 pl-4 text-left font-normal">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <MemberAvatar identity={row.worker} />
                        <span className="truncate font-medium">{getMemberDisplayName(row.worker)}</span>
                      </span>
                    </th>
                    {COLUMNS.map((column, index) => {
                      const value = column.value(row);
                      return (
                        <td
                          key={column.key}
                          className={cn(
                            "py-2 pl-2.5 text-right",
                            index === COLUMNS.length - 1 ? "pr-4" : "pr-2.5",
                            figureClass,
                            // Zeros and unavailable figures read slate in every column.
                            (value === null || value === 0) && "text-muted-foreground",
                          )}
                        >
                          {display(column, value)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            <ul aria-label="Respark by specialist" className="flex flex-col @2xl/respark:hidden">
              {report.rows.map((row) => (
                <li key={row.workerId} className="flex flex-col gap-1 border-b px-4 py-2.5 last:border-b-0">
                  <p className="truncate font-semibold">{getMemberDisplayName(row.worker)}</p>
                  <Words row={row} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {quiet ? null : (
        <DetailCardFooter className="block py-2.5 text-[13px] font-normal">
          <p className="max-w-[75ch] text-pretty">
            Raw leads follow the source filter; resparks cover every source. Not a fit share is not a fit ÷ (resparks +
            not a fit). Resparked, then booked counts respark credits dated {rangePhrase} whose deal has booked, later
            bookings included.
          </p>
        </DetailCardFooter>
      )}
    </DetailCard>
  );
}
