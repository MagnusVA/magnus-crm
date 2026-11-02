"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { BusinessDaySetting } from "@/lib/businessDay";
import {
  dealStanding,
  NO_BOOK_FILTER,
  programLabel,
  RECORD_AGE_LABELS,
  type BookFilter,
  type BookProgram,
  type BookSummary,
  type DealState,
  type DeskDeal,
  visibleBookDeals,
} from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { personDate } from "@/app/workspace/leads-customers/[leadId]/_components/person-format";
import { NextStep, StageWord } from "./deal-cells";
import { OpenDealDetails } from "./open-deal-details";

// Open deals: the book as one list by what's next (DESIGN.md, The Open Deal
// Row). The panel above and the controls here set the same filter. A row
// opens in place to the deal's calls, contact, credit and actions.

const PAGE = 25;
const ANY_PROGRAM = "__any";
const DAY = 86_400_000;
/** How long a row takes to close before its details unmount. */
const CLOSE_MS = 250;
/** An age bar is full at this many days. */
const FULL_AGE_DAYS = 120;

const STATES: Array<{ value: "all" | DealState; label: string }> = [
  { value: "all", label: "All" },
  { value: "ahead", label: "Ahead" },
  { value: "no_step", label: "No next step" },
  { value: "not_recorded", label: "Not recorded" },
];

/** Person, deal, last activity, next step, the opener. Folds below @4xl. */
const ROW_GRID =
  "@4xl/deals:grid-cols-[minmax(0,1.15fr)_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1.25fr)_1.75rem]";

type Clock = { now: number; setting: BusinessDaySetting };

export function OpenDeals({
  deals,
  summary,
  programs,
  isPartial,
  filter,
  onFilter,
  now,
  setting,
}: {
  deals: DeskDeal[];
  summary: BookSummary;
  programs: BookProgram[];
  isPartial: boolean;
  filter: BookFilter;
  onFilter: (filter: BookFilter) => void;
} & Clock) {
  const [shown, setShown] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);
  // A new filter starts the list again from its top.
  const filterKey = `${filter.state}|${filter.age}|${filter.programKey}`;
  const [shownFor, setShownFor] = useState(filterKey);
  if (shownFor !== filterKey) {
    setShownFor(filterKey);
    setShown(PAGE);
  }

  const { rows, matched } = visibleBookDeals(deals, filter, openId, now, shown);
  // The filter's deals on screen; a kept open row doesn't count toward them.
  const listed = Math.min(shown, matched);
  const filtered = filter.state !== null || filter.programKey !== null;
  const program = programs.find((entry) => entry.key === filter.programKey) ?? null;
  const counts: Record<"all" | DealState, number> = {
    all: summary.total,
    ahead: summary.ahead,
    no_step: summary.noStep,
    not_recorded: summary.notRecorded,
  };

  return (
    <section
      aria-labelledby="open-deals-title"
      className="@container/deals scroll-mt-4 rounded-xl border bg-card text-sm text-card-foreground"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <h2 id="open-deals-title" className="mr-1 text-[15px] font-semibold">
          Open deals
        </h2>
        <ToggleGroup
          type="single"
          size="sm"
          value={filter.state ?? "all"}
          onValueChange={(next) => {
            const state = STATES.find((entry) => entry.value === next)?.value;
            if (state) onFilter({ ...filter, state: state === "all" ? null : state, age: null });
          }}
          aria-label="Open deals by where they stand"
          className="h-auto max-w-full flex-wrap justify-start rounded-[7px] border bg-background p-0.5"
        >
          {STATES.map((entry) => (
            <ToggleGroupItem
              key={entry.value}
              value={entry.value}
              className="h-6 gap-1 rounded-[5px]! px-2.5 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]"
            >
              {entry.label}
              <span className="tabular-nums">{counts[entry.value]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Select
          value={filter.programKey ?? ANY_PROGRAM}
          onValueChange={(next) => onFilter({ ...filter, programKey: next === ANY_PROGRAM ? null : next })}
        >
          <SelectTrigger
            size="sm"
            aria-label="Program"
            className="h-[30px] max-w-[16rem] min-w-[9.5rem] rounded-[7px] text-[13px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={ANY_PROGRAM}>All programs</SelectItem>
            {programs.length > 0 ? <SelectSeparator /> : null}
            {programs.map((entry) => (
              <SelectItem key={entry.key} value={entry.key}>
                {programLabel(entry.name)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filter.age !== null ? (
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] gap-1.5 rounded-[7px] text-[13px]"
            onClick={() => onFilter({ ...filter, age: null })}
          >
            {RECORD_AGE_LABELS[filter.age]}
            <XIcon aria-hidden="true" className="size-3.5" />
            <span className="sr-only">Clear the age filter</span>
          </Button>
        ) : null}
        <span className="ml-auto hidden text-[13px] text-muted-foreground @2xl/deals:inline">
          {filter.state === "not_recorded" ? "Oldest call first" : "By what's next"}
        </span>
      </header>

      {rows.length === 0 ? (
        <SectionEmpty title={emptyTitle(filter, program)}>
          {filtered ? (
            <Button variant="outline" size="sm" className="mt-2" onClick={() => onFilter(NO_BOOK_FILTER)}>
              Clear filters
            </Button>
          ) : null}
        </SectionEmpty>
      ) : (
        <>
          <div
            aria-hidden="true"
            className={cn(
              "hidden h-7 items-center gap-x-4 border-b px-4 font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase @4xl/deals:grid",
              ROW_GRID,
            )}
          >
            <span>Person</span>
            <span>Deal</span>
            <span>Last activity</span>
            <span>Next step</span>
            <span />
          </div>
          <ul>
            {rows.map((deal) => (
              <DealRow
                key={deal.opportunityId}
                deal={deal}
                programs={programs}
                isOpen={openId === deal.opportunityId}
                onToggle={() => setOpenId((id) => (id === deal.opportunityId ? null : deal.opportunityId))}
                now={now}
                setting={setting}
              />
            ))}
          </ul>
          <footer className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t px-4 py-2 text-[13px] text-muted-foreground">
            <span className="tabular-nums">
              {listed < matched
                ? `Showing ${listed} of ${matched}`
                : `${matched} ${matched === 1 ? "deal" : "deals"}`}
              {isPartial ? " · your oldest open deals aren't listed" : ""}
            </span>
            {listed < matched ? (
              <Button variant="outline" size="sm" onClick={() => setShown((count) => count + PAGE)}>
                Show {Math.min(PAGE, matched - listed)} more
              </Button>
            ) : null}
          </footer>
        </>
      )}
    </section>
  );
}

function emptyTitle(filter: BookFilter, program: BookProgram | null) {
  const inProgram = filter.programKey !== null ? ` in ${programLabel(program?.name ?? null)}` : "";
  if (filter.state === "ahead") return `No open deal has a next step${inProgram}.`;
  if (filter.state === "no_step") return `Every open deal${inProgram} has a next step or a call to record.`;
  if (filter.state === "not_recorded") {
    const age = filter.age ? ` ${RECORD_AGE_LABELS[filter.age].toLowerCase()} ago` : "";
    return `No call${age} is waiting for an outcome${inProgram}.`;
  }
  return `No open deals${inProgram}.`;
}

function DealRow({
  deal,
  programs,
  isOpen,
  onToggle,
  now,
  setting,
}: {
  deal: DeskDeal;
  programs: BookProgram[];
  isOpen: boolean;
  onToggle: () => void;
} & Clock) {
  const { state, missedCallAt } = dealStanding(deal, now);
  const programName = programs.find((entry) => entry.key === deal.programKey)?.name ?? null;
  const detailsId = `deal-${deal.opportunityId}`;
  const recordHref =
    state === "not_recorded" && deal.nextMeetingId ? `/workspace/closer/meetings/${deal.nextMeetingId}` : null;
  // Days since the call that was never recorded: the age bar's length.
  const ageDays = missedCallAt !== null ? Math.max(0, (now - missedCallAt) / DAY) : 0;
  // The details stay mounted until the row has finished closing (200ms),
  // then unmount so a closed row holds no subscription.
  const [mounted, setMounted] = useState(isOpen);
  if (isOpen && !mounted) setMounted(true);
  useEffect(() => {
    if (isOpen || !mounted) return;
    const timer = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [isOpen, mounted]);

  return (
    <li className="border-t first:border-t-0">
      <div
        className={cn(
          "relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2 hover:bg-accent/60 @xl/deals:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] @4xl/deals:min-h-12",
          ROW_GRID,
          isOpen && "bg-accent/40",
        )}
      >
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={detailsId}
          onClick={onToggle}
          className="truncate text-left text-[15px] leading-5 font-semibold outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          translate="no"
        >
          {deal.personName}
        </button>

        <p className="col-start-1 flex min-w-0 items-baseline gap-1.5 @xl/deals:col-start-auto">
          <span className={cn("truncate", programName === null && "text-muted-foreground")}>
            {programLabel(programName)}
          </span>
          <StageWord position={deal.position} className="shrink-0" />
        </p>

        <div className="col-start-1 min-w-0 @xl/deals:col-start-auto">
          {state === "not_recorded" && missedCallAt !== null ? (
            <p className="flex items-center gap-1.5 leading-5">
              <span className="font-condensed text-[15px] font-semibold tabular-nums">
                {personDate(missedCallAt, setting, now)} call
              </span>
              <span className="inline-flex h-5 items-center rounded-[4px] bg-warning-surface px-1.5 text-xs font-semibold whitespace-nowrap text-warning-ink">
                Not recorded
              </span>
            </p>
          ) : (
            <p className="leading-5 text-muted-foreground">
              <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">
                {personDate(deal.lastActivityAt, setting, now)}
              </span>
            </p>
          )}
          {state === "not_recorded" ? (
            <span
              aria-hidden="true"
              className="mt-1 block h-1 w-full max-w-36 overflow-hidden rounded-full bg-muted"
              title={`${Math.floor(ageDays)} days`}
            >
              <span
                className="block h-full rounded-full bg-warning"
                style={{ width: `${Math.min(100, Math.max(4, (ageDays / FULL_AGE_DAYS) * 100))}%` }}
              />
            </span>
          ) : null}
        </div>

        <div className="col-start-1 min-w-0 @xl/deals:col-start-auto">
          {state === "not_recorded" ? (
            recordHref && !isOpen ? (
              <Link href={recordHref} className={cn(detailLinkClass, "relative z-10")}>
                Record outcome
              </Link>
            ) : (
              <span className="text-muted-foreground">—</span>
            )
          ) : (
            <NextStep next={deal.nextStep} now={now} setting={setting} />
          )}
        </div>

        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "col-start-2 row-start-1 size-4 justify-self-end text-muted-foreground transition-transform duration-200 @xl/deals:col-start-3 @4xl/deals:col-start-5",
            isOpen && "rotate-180",
          )}
        />
      </div>
      <div
        id={detailsId}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!isOpen}>
          {mounted ? (
            <OpenDealDetails
              opportunityId={deal.opportunityId}
              leadId={deal.leadId}
              recordHref={recordHref}
              now={now}
              setting={setting}
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}
