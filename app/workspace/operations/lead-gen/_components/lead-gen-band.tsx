"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { PageBand } from "@/app/workspace/_components/page-band";
import { TextPlaceholder } from "@/app/workspace/_components/text-placeholder";
import { cn } from "@/lib/utils";
import { BandCaptionLink, MovedToTeamChip, teamHref } from "../../_components/team-links";
import { formatCount, formatHours, formatPerHour } from "./lead-gen-format";
import type { LeadGenSource } from "./lead-gen-admin-page-client";

// The page's header (DESIGN.md, PageBand): the title, what the numbers cover
// and how fresh they are, the range picker, then the four totals in the book
// panel's grammar and the source tabs that filter the page.

type Totals = {
  submissions: number;
  scheduledHours: number;
  leadsPerHour: number | null;
};

const SOURCES: ReadonlyArray<{ value: LeadGenSource | undefined; label: string }> = [
  { value: undefined, label: "All sources" },
  { value: "instagram", label: "Instagram" },
  { value: "meta_business", label: "Meta Business" },
];

function Total({
  label,
  children,
  line,
}: {
  label: string;
  children: ReactNode;
  line: ReactNode;
}) {
  return (
    // Two by two, ruled between; from @3xl four across, ruled left.
    <div className="flex min-w-0 flex-col border-board-line px-4 py-3 even:border-l @lg:px-[18px] [&:nth-child(n+3)]:border-t @3xl:[&:nth-child(n+2)]:border-l @3xl:[&:nth-child(n+3)]:border-t-0">
      <dt className="font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase">{label}</dt>
      <dd className="mt-1 font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums">{children}</dd>
      <dd className="mt-0.5 text-[13px] text-pretty text-board-foreground/75">{line}</dd>
    </div>
  );
}

function Unit({ children }: { children: ReactNode }) {
  return <span className="ml-0.5 font-sans text-[13px] font-medium text-board-muted">{children}</span>;
}

/** A figure still loading: placeholder text in the figure's type, so the zone keeps its height. */
function Waiting() {
  return <TextPlaceholder sample="000" />;
}

export function LeadGenTotals({
  totals,
  specialistCount,
  rangePhrase,
  reloading,
}: {
  totals: Totals | undefined;
  specialistCount: number | undefined;
  rangePhrase: string;
  reloading: boolean;
}) {
  return (
    <dl
      aria-busy={reloading || totals === undefined}
      aria-label="Totals"
      className={cn(
        "-mx-4 grid grid-cols-2 border-t border-board-line @lg:-mx-[18px] @3xl:grid-cols-4",
        "transition-opacity duration-200 motion-reduce:transition-none",
        reloading && "opacity-60",
      )}
    >
      <Total label="Submissions" line="Every capture, repeat people included">
        {totals ? formatCount(totals.submissions) : <Waiting />}
      </Total>
      <Total label="Specialists active" line={`With a submission ${rangePhrase}`}>
        {specialistCount === undefined ? <Waiting /> : formatCount(specialistCount)}
      </Total>
      <Total
        label="Scheduled hours"
        line={
          <BandCaptionLink
            href={teamHref.schedules("lead_gen")}
            tip="The hours in every lead gen specialist's week, set in Team › Schedules. Specialists with no schedule add captures but no hours."
          >
            Across every specialist&apos;s schedule
          </BandCaptionLink>
        }
      >
        {totals ? (
          <>
            {formatHours(totals.scheduledHours)}
            <Unit>h</Unit>
          </>
        ) : (
          <Waiting />
        )}
      </Total>
      <Total
        label="Per scheduled hour"
        line={
          <BandCaptionLink
            href={teamHref.schedules("lead_gen")}
            tip="Submissions ÷ the hours scheduled in Team › Schedules. Change a week there; this figure follows."
          >
            Submissions ÷ scheduled hours
          </BandCaptionLink>
        }
      >
        {totals === undefined ? (
          <Waiting />
        ) : totals.leadsPerHour === null ? (
          <span className="font-sans text-[15px] font-medium text-board-muted">No schedule</span>
        ) : (
          <>
            {formatPerHour(totals.leadsPerHour)}
            <Unit>/h</Unit>
          </>
        )}
      </Total>
    </dl>
  );
}

/** All sources, Instagram, Meta Business: one choice that filters the page. */
function SourceTabs({
  source,
  onSourceChange,
}: {
  source: LeadGenSource | undefined;
  onSourceChange: (next: LeadGenSource | undefined) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const current = SOURCES.findIndex((entry) => entry.value === source);

  const select = (index: number) => {
    const next = (index + SOURCES.length) % SOURCES.length;
    onSourceChange(SOURCES[next].value);
    listRef.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") select(current + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") select(current - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(SOURCES.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label="Source"
      onKeyDown={onKeyDown}
      className="flex min-w-0 gap-4 overflow-x-auto [scrollbar-width:none] @xl:gap-[22px]"
    >
      {SOURCES.map((entry, index) => {
        const selected = index === current;
        return (
          <button
            key={entry.label}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSourceChange(entry.value)}
            className={cn(
              "h-10 shrink-0 border-b-2 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected
                ? "border-primary text-board-foreground"
                : "border-transparent text-board-muted hover:text-board-foreground",
            )}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}

export function LeadGenBand({
  description,
  picker,
  exportMenu,
  totals,
  specialistCount,
  rangePhrase,
  reloading,
  source,
  onSourceChange,
}: {
  /** The range in words, freshness and the business-day line. */
  description: ReactNode;
  picker: ReactNode;
  exportMenu: ReactNode;
  totals: Totals | undefined;
  specialistCount: number | undefined;
  rangePhrase: string;
  reloading: boolean;
  source: LeadGenSource | undefined;
  onSourceChange: (next: LeadGenSource | undefined) => void;
}) {
  return (
    <PageBand title="Lead Gen" description={description} actions={picker}>
      <LeadGenTotals
        totals={totals}
        specialistCount={specialistCount}
        rangePhrase={rangePhrase}
        reloading={reloading}
      />
      <div className="-mx-4 flex flex-wrap items-center justify-between gap-x-4 border-t border-board-line px-4 @lg:-mx-[18px] @lg:px-[18px]">
        <SourceTabs source={source} onSourceChange={onSourceChange} />
        <div
          className={cn(
            "flex items-center gap-2 py-1.5",
            // The shared export menu's trigger is an outline button; on the
            // band it takes the board button's fill like the picker does.
            // The export menu's trigger is the wrapper's one direct <button>
            // (its data-slot belongs to the dropdown); `!` beats the outline
            // variant's dark-scope fill.
            "[&>button]:h-7 [&>button]:rounded-[5.6px] [&>button]:border-board-foreground/15! [&>button]:bg-board-raised! [&>button]:text-[13px] [&>button]:text-board-foreground! [&>button:hover]:bg-board-foreground/10! [&>button[aria-expanded=true]]:bg-board-foreground/10!",
          )}
        >
          {exportMenu}
          <MovedToTeamChip
            href={teamHref.members("lead_gen")}
            moved={["Settings & schedules"]}
            tip="Specialists, teams and schedules now live in Team. The capture rules moved to Settings."
          />
        </div>
      </div>
    </PageBand>
  );
}
