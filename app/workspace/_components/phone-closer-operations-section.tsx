import { Fragment } from "react";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { cn } from "@/lib/utils";
import { getMemberDisplayName } from "./member-avatar";
import type { PhoneCloserOperationsSectionData } from "./overview-dashboard-types";
import { formatRate, formatWholeNumber } from "./overview-formatters";
import { OverviewPartialNote, OverviewSectionState } from "./overview-section-state";
import { ATTENDANCE_COUNTS_PARTIAL_HELP } from "./results-recorded";

// Overview's phone closers: booked-call outcomes per assigned closer, one
// ruled table with a Total row. Below @xl/closers each closer folds to two
// lines: the name, then the counts in words. When attendance counts are
// partial, one note above the rows says why, for the table and the list.
// Canceled and moved slots (a call rescheduled to another time) are counted
// apart, under each name, so the six figure columns still fit.

type ReadyData = Extract<PhoneCloserOperationsSectionData, { status: "ready" }>["data"];
type Counts = ReadyData["totals"];

// Show and no-show rates read "—" when no call was held or missed, as every
// other show-rate screen does.
function formatShowRate(value: number | null) {
  return value === null ? "—" : formatRate(value);
}

function resultsLine(counts: Counts, partial: boolean) {
  return `${formatWholeNumber(counts.resultsRecorded)} of ${formatWholeNumber(counts.pastCalls)} past calls have a result${partial ? " (partial)" : ""}`;
}

/** Calls due with no held or no-show result yet. */
function notRecorded(counts: Counts) {
  return counts.pastCalls - counts.resultsRecorded;
}

function slotsLine(counts: Counts) {
  return `${formatWholeNumber(counts.canceled)} canceled · ${formatWholeNumber(counts.moved)} moved`;
}

const figure = "font-condensed text-[15px] font-semibold tabular-nums";
// Two-word heads ("Show rate") break onto two lines, so all six figure columns fit a half-width card.
const head = "min-h-7 px-2.5 py-1 text-right align-bottom font-condensed text-[11px] leading-tight font-semibold tracking-[0.14em] text-muted-foreground uppercase";

function Figures({ counts, strong = false }: { counts: Counts; strong?: boolean }) {
  return (
    <>
      <td className={cn("px-2.5 text-right", figure)}>{formatWholeNumber(counts.scheduled)}</td>
      <td className={cn("px-2.5 text-right", figure)}>{formatWholeNumber(counts.held)}</td>
      <td className={cn("px-2.5 text-right", figure, counts.noShows === 0 && !strong && "text-muted-foreground")}>
        {formatWholeNumber(counts.noShows)}
      </td>
      <td className={cn("px-2.5 text-right", figure, notRecorded(counts) === 0 && !strong && "text-muted-foreground")}>
        {formatWholeNumber(notRecorded(counts))}
      </td>
      <td className={cn("px-2.5 text-right", figure)}>{formatShowRate(counts.showRate)}</td>
      <td className={cn("pr-4 pl-2.5 text-right", figure)}>{formatShowRate(counts.noShowRate)}</td>
    </>
  );
}

function CountWords({ counts }: { counts: Counts }) {
  const facts: Array<[string, string]> = [
    [formatWholeNumber(counts.scheduled), "booked"],
    [formatWholeNumber(counts.held), "held"],
    [formatWholeNumber(counts.noShows), "no-show"],
    [formatWholeNumber(counts.canceled), "canceled"],
    [formatWholeNumber(counts.moved), "moved"],
    [formatWholeNumber(notRecorded(counts)), "not recorded"],
    [formatShowRate(counts.showRate), "show rate"],
    [formatShowRate(counts.noShowRate), "no-show rate"],
  ];
  return (
    <p className="text-[13px] text-muted-foreground">
      {facts.map(([value, word], index) => (
        <Fragment key={word}>
          <span className="whitespace-nowrap">
            <span className={cn(figure, "text-foreground")}>{value}</span> {word}
          </span>
          {index < facts.length - 1 ? " · " : null}
        </Fragment>
      ))}
    </p>
  );
}

function PhoneClosersTable({ data }: { data: ReadyData }) {
  const partial = data.attendanceCountsPartial;
  return (
    <div className="@container/closers">
      {partial ? <OverviewPartialNote>{ATTENDANCE_COUNTS_PARTIAL_HELP}</OverviewPartialNote> : null}
      <table className="hidden w-full border-collapse @xl/closers:table">
        <caption className="sr-only">Booked-call outcomes by phone closer</caption>
        <thead>
          <tr className="border-b">
            <th scope="col" className={cn(head, "pl-4 text-left")}>
              Phone closer
            </th>
            <th scope="col" className={head}>Booked</th>
            <th scope="col" className={head}>Held</th>
            <th scope="col" className={head}>No-show</th>
            <th scope="col" className={head}>Not recorded</th>
            <th scope="col" className={head}>
              Show rate
            </th>
            <th scope="col" className={cn(head, "pr-4")}>
              No-show rate
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.closerId} className="border-b">
              <th scope="row" className="py-2 pr-3 pl-4 text-left font-normal">
                <p className="font-semibold">{getMemberDisplayName(row.closer)}</p>
                <p className="text-[13px] text-muted-foreground">{resultsLine(row, partial)}</p>
                <p className="text-[13px] text-muted-foreground">{slotsLine(row)}</p>
              </th>
              <Figures counts={row} />
            </tr>
          ))}
          <tr className="bg-muted/40">
            <th scope="row" className="py-2 pr-3 pl-4 text-left">
              <p className="font-semibold">Total</p>
              <p className="text-[13px] font-normal text-muted-foreground">{resultsLine(data.totals, partial)}</p>
              <p className="text-[13px] font-normal text-muted-foreground">{slotsLine(data.totals)}</p>
            </th>
            <Figures counts={data.totals} strong />
          </tr>
        </tbody>
      </table>

      <ul aria-label="Booked-call outcomes by phone closer" className="flex flex-col @xl/closers:hidden">
        {data.rows.map((row) => (
          <li key={row.closerId} className="flex flex-col gap-1 border-b px-4 py-2.5">
            <p className="truncate font-semibold">{getMemberDisplayName(row.closer)}</p>
            <CountWords counts={row} />
          </li>
        ))}
        <li className="flex flex-col gap-1 bg-muted/40 px-4 py-2.5">
          <p className="font-semibold">Total</p>
          <CountWords counts={data.totals} />
          <p className="text-[13px] text-muted-foreground">{resultsLine(data.totals, partial)}</p>
        </li>
      </ul>
    </div>
  );
}

export function PhoneCloserOperationsSection({
  section,
  rangePhrase = "in this range",
}: {
  section: PhoneCloserOperationsSectionData;
  /** How the empty line names the range: "today", "this week", "in this range". */
  rangePhrase?: string;
}) {
  return (
    <DetailCard title="Phone closers" meta="Show rate: held ÷ (held + no-show)" className="min-w-0">
      {section.status === "ready" ? (
        <PhoneClosersTable data={section.data} />
      ) : (
        <OverviewSectionState section={section} emptyTitle={`No calls booked with phone closers ${rangePhrase}.`} />
      )}
    </DetailCard>
  );
}
