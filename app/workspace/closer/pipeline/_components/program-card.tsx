"use client";

import { useState } from "react";
import Link from "next/link";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { formatCash, type PipelineMonth, type ProgramSection } from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import {
  DetailCard,
  DetailCardFooter,
  detailLinkClass,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { dealHref, NextStep, ROW_LINK, StageWord } from "./deal-cells";

// A card shows this many open deals before "Show N more": fewer when cards
// sit two up, so a sparse card beside it doesn't stretch into a tall empty
// box. The ones with no next step sort first, so they are never hidden.
const ROWS_SHOWN = { alone: 8, paired: 5 } as const;

const COLUMNS = "sm:grid-cols-[minmax(0,1.15fr)_6.5rem_minmax(0,1.5fr)]";

/** The program's name, or the words for the deals with none. */
export function programLabel(name: string | null) {
  return name ?? "No program";
}

/**
 * One program on the desk: its cash and wins in the month in the title row,
 * its open deals (person, stage word, next step) as ruled rows, and a footer
 * with its open and closed counts and the link to all its deals below.
 */
export function ProgramCard({
  section,
  month,
  now,
  setting,
  paired,
  onShowAll,
}: {
  section: ProgramSection;
  month: PipelineMonth;
  now: number;
  setting: BusinessDaySetting;
  /** Whether the card sits beside another at xl. */
  paired: boolean;
  onShowAll: (programKey: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const name = programLabel(section.name);
  const titleId = `program-${section.key}-title`;
  const shown = expanded
    ? section.deals
    : section.deals.slice(0, paired ? ROWS_SHOWN.paired : ROWS_SHOWN.alone);
  const hidden = section.deals.length - shown.length;

  return (
    <DetailCard
      title={name}
      titleId={titleId}
      aria-labelledby={titleId}
      role="region"
      // A card with no open deals keeps its one quiet line instead of
      // stretching to its neighbour's height.
      className={cn("min-w-0 text-sm", section.deals.length === 0 && "self-start")}
      metaClassName="basis-full ml-0 sm:basis-auto sm:ml-auto"
      meta={section.name === null ? null : <ProgramMeta section={section} month={month} />}
    >
      {section.deals.length === 0 ? (
        <SectionEmpty title={`No open deals in ${name}.`} className="py-3.5" />
      ) : (
        <>
          <div
            aria-hidden
            className={cn(
              "hidden h-7 items-center gap-x-4 border-b px-4 font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase sm:grid",
              COLUMNS,
            )}
          >
            <span>Person</span>
            <span>Stage</span>
            <span>Next step</span>
          </div>
          <ul aria-label={`Open deals in ${name}`}>
            {shown.map((deal) => (
              <li
                key={deal.opportunityId}
                className={cn(
                  "relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t px-4 py-2 first:border-t-0 hover:bg-accent/60 sm:min-h-10 sm:py-1.5",
                  COLUMNS,
                )}
              >
                <Link
                  href={dealHref(deal.leadId, deal.opportunityId)}
                  className={cn(ROW_LINK, "truncate font-semibold")}
                >
                  {deal.personName}
                </Link>
                <StageWord position={deal.position} className="justify-self-end sm:justify-self-start" />
                <span className="col-span-2 flex min-w-0 text-[13px] sm:col-span-1 sm:text-sm">
                  <NextStep next={deal.nextStep} now={now} setting={setting} />
                </span>
              </li>
            ))}
          </ul>
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="flex h-9 w-full items-center border-t px-4 text-left text-[13px] font-medium text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              Show {hidden} more
            </button>
          ) : null}
        </>
      )}
      <DetailCardFooter className="mt-auto text-[13px]">
        <span className="tabular-nums">
          {section.deals.length} open · {section.closed} closed
        </span>
        <button type="button" className={detailLinkClass} onClick={() => onShowAll(section.key)}>
          {section.name === null ? "All deals with no program" : `All ${name} deals`}
        </button>
      </DetailCardFooter>
    </DetailCard>
  );
}

/**
 * "L 25,000 · $12,600 collected · 3 won this month": the program's own
 * currency first, or "No cash this month".
 */
function ProgramMeta({ section, month }: { section: ProgramSection; month: PipelineMonth }) {
  const period = month.isCurrent ? "this month" : `in ${month.name}`;
  return (
    <span className="truncate">
      {section.cash.length === 0 ? (
        `No cash ${period}`
      ) : (
        <>
          {section.cash.map((entry, index) => (
            <span key={entry.currency}>
              {index > 0 ? " · " : null}
              <b className="font-condensed text-base font-semibold text-foreground tabular-nums">
                {formatCash(entry.amountMinor, entry.currency)}
              </b>
            </span>
          ))}{" "}
          collected
        </>
      )}
      {section.won > 0 ? ` · ${section.won} won ${period}` : null}
    </span>
  );
}
