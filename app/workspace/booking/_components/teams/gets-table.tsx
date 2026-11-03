import Link from "next/link";
import { cn } from "@/lib/utils";
import { CalendlyDot } from "../calendly-dot";
import { ACCESS_TIP, ACCESS_TONE, ACCESS_WORD, type LaneAccess, type ProgramAccess } from "./team-access";
import { HelpTip, LABEL } from "./team-ui";

const ROW = "grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] items-start gap-2.5 px-3 py-[7px] text-[13px]";

/** One lane: the reason word, then the event type its link books (when it books). */
function LaneCell({ access }: { access: LaneAccess }) {
  const eventType = "eventType" in access ? access.eventType : undefined;
  return (
    <div className="min-w-0">
      <span
        className={cn(
          "block font-condensed text-[11px] leading-[1.1] font-bold tracking-[0.08em] whitespace-nowrap uppercase",
          ACCESS_TONE[access.word],
        )}
      >
        <HelpTip tip={ACCESS_TIP[access.word]} className="no-underline">
          {ACCESS_WORD[access.word]}
        </HelpTip>
      </span>
      {access.word === "broken" ? (
        <small className="mt-0.5 block truncate text-[12px] text-danger-ink" title={access.reason}>
          {access.reason}
        </small>
      ) : eventType ? (
        <small className="mt-0.5 flex min-w-0 items-center gap-[5px] text-[12px] text-muted-foreground">
          <CalendlyDot color={eventType.calendlyColor} className="size-2.5" />
          <span className="truncate" title={eventType.displayName}>
            {eventType.displayName}
          </span>
        </small>
      ) : null}
    </div>
  );
}

/**
 * Program × Priority/Standard with the reason for each lane, as concept B's
 * "What Cole's closers get" and "What Ana gets". `teamId` links each program to
 * its row on Coverage.
 */
export function GetsRows({
  rows,
  teamId,
  showHead = true,
}: {
  rows: readonly ProgramAccess[];
  teamId: string;
  showHead?: boolean;
}) {
  return (
    <div role="table" aria-label="Links per program and lane">
      {showHead ? (
        <div role="row" className={cn(ROW, "pt-2.5")}>
          <span role="columnheader" className={LABEL}>Program</span>
          <span role="columnheader" className={LABEL}>
            <HelpTip tip="The link for the program's Priority event type (any event type not marked Standard).">Priority</HelpTip>
          </span>
          <span role="columnheader" className={LABEL}>
            <HelpTip tip="The link for the program's Standard event type, the one marked Standard (usually the Extended pool that books further out).">Standard</HelpTip>
          </span>
        </div>
      ) : null}
      {rows.map((row) => (
        <div key={row.program._id} role="row" className={cn(ROW, "border-t border-border")}>
          <span role="rowheader" className="min-w-0">
            <Link
              href={`/workspace/booking?team=${teamId}&program=${row.program._id}`}
              className="rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {row.program.name}
            </Link>
          </span>
          <span role="cell" className="min-w-0">
            <LaneCell access={row.lanes.normal} />
          </span>
          <span role="cell" className="min-w-0">
            <LaneCell access={row.lanes.extended} />
          </span>
        </div>
      ))}
    </div>
  );
}
