"use client";

import { useState } from "react";
import {
  amountIn,
  formatCash,
  programLabel,
  RECORD_AGE_LABELS,
  type BookFilter,
  type BookProgram,
  type BookSummary,
  type CurrencyAmount,
  type DealState,
  type PipelineMonth,
  type RecordAge,
} from "@/lib/closer-pipeline";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { personDate } from "@/app/workspace/leads-customers/[leadId]/_components/person-format";

// The book on one navy panel (DESIGN.md, The Book Panel): the month's money,
// where every open deal stands, and the programs that carry them. Every
// count on it is a filter for the open-deals list under it.

/** The panel shows this many programs before "N more". */
const PROGRAMS_SHOWN = 8;

const LABEL = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase";
const FIGURE = "font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums";
const DETAIL = "text-[13px] text-board-foreground/75";

/** A segment of the state bar: what it counts, its fill, and the filter it sets. */
type Segment = {
  key: string;
  label: string;
  count: number;
  fill: string;
  filter: Pick<BookFilter, "state" | "age">;
};

/**
 * Amber marks what the closer owes on this page. A deal with no next step is
 * hollow: nothing is booked in it. The calls never recorded are solid amber
 * that thins into stripes as they age: they are going cold.
 */
const AGE_FILL: Record<RecordAge, string> = {
  under_30: "bg-warning",
  "30_90": "bg-[repeating-linear-gradient(135deg,var(--color-warning)_0_3px,transparent_3px_5px)]",
  over_90: "bg-[repeating-linear-gradient(135deg,var(--color-warning)_0_1.5px,transparent_1.5px_5px)]",
};
const NO_STEP_FILL = "ring-[1.5px] ring-inset ring-warning";

function segmentsOf(summary: BookSummary): Segment[] {
  return [
    {
      key: "ahead",
      label: "Ahead",
      count: summary.ahead,
      fill: "bg-board-foreground/70",
      filter: { state: "ahead", age: null },
    },
    {
      key: "no_step",
      label: "No next step",
      count: summary.noStep,
      fill: NO_STEP_FILL,
      filter: { state: "no_step", age: null },
    },
    ...(["under_30", "30_90", "over_90"] as const).map((age) => ({
      key: age,
      label: age === "under_30" ? "Not recorded, under 30 days" : RECORD_AGE_LABELS[age],
      count: summary.ages[age],
      fill: AGE_FILL[age],
      filter: { state: "not_recorded" as DealState, age },
    })),
  ];
}

function isSelected(segment: Segment, filter: BookFilter) {
  return segment.filter.state === filter.state && segment.filter.age === filter.age;
}

export type BookPanelProps = {
  month: PipelineMonth;
  currency: string;
  cash: { currencies: CurrencyAmount[]; paymentCount: number; isPartial: boolean };
  /** The previous period's cash, or undefined while it loads. */
  previous: { currencies: CurrencyAmount[] } | undefined;
  wins: { won: number; decided: number; isPartial: boolean };
  summary: BookSummary;
  isPartial: boolean;
  programs: BookProgram[];
  filter: BookFilter;
  onFilter: (filter: BookFilter) => void;
  setting: BusinessDaySetting;
  now: number;
};

export function BookPanel(props: BookPanelProps) {
  const { month } = props;
  return (
    <section
      aria-label={`${month.name} and your open deals`}
      className="@container/book rounded-xl bg-board text-board-foreground dark:ring-1 dark:ring-board-foreground/10"
    >
      <div className="grid @4xl/book:grid-cols-[minmax(12rem,0.7fr)_minmax(0,1.55fr)] @5xl/book:grid-cols-[minmax(10rem,0.5fr)_minmax(0,1.2fr)_minmax(25rem,1.2fr)]">
        <MonthZone {...props} />
        <BookZone {...props} />
        <ProgramsZone {...props} />
      </div>
    </section>
  );
}

const ZONE =
  "flex min-w-0 flex-col px-4 py-3.5 sm:px-[18px] border-board-line not-first:border-t @4xl/book:not-first:border-t-0 @4xl/book:not-first:border-l";

function MonthZone({ month, currency, cash, previous, wins }: BookPanelProps) {
  const amount = amountIn(cash.currencies, currency);
  const others = cash.currencies.filter((entry) => entry.currency !== currency);
  const previousAmount = previous ? amountIn(previous.currencies, currency) : null;
  // Nothing in either period says nothing; leave the change out.
  const change =
    previousAmount === null || (amount === 0 && previousAmount === 0) ? null : amount - previousAmount;
  const partial = (flag: boolean) => (flag ? " (partial)" : "");

  return (
    <dl className={cn(ZONE, "grid grid-cols-2 gap-x-7 gap-y-3.5 @4xl/book:grid-cols-1 @4xl/book:content-start")}>
      <div className="flex min-w-0 flex-col">
        <dt className={LABEL}>Cash collected · {month.name}</dt>
        <dd className="contents">
          <span className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className={cn(FIGURE, "text-primary")}>{formatCash(amount, currency)}</span>
            {others.map((entry) => (
              <span
                key={entry.currency}
                className="font-condensed text-[17px] leading-none font-semibold tabular-nums"
              >
                {formatCash(entry.amountMinor, entry.currency)}
              </span>
            ))}
          </span>
          <span className={cn(DETAIL, "mt-0.5")}>
            {change !== null ? (
              <>
                <span
                  className={cn(
                    "font-semibold",
                    change > 0 ? "text-primary" : change < 0 ? "text-board-danger" : "text-board-foreground",
                  )}
                >
                  {change === 0 ? "No change" : formatCash(change, currency, true)}
                </span>{" "}
                {month.comparisonLabel} ·{" "}
              </>
            ) : null}
            {cash.paymentCount === 0
              ? month.isCurrent
                ? "No payments yet"
                : "No payments"
              : `${cash.paymentCount} ${cash.paymentCount === 1 ? "payment" : "payments"}`}
            {partial(cash.isPartial)}
          </span>
        </dd>
      </div>
      <div className="flex min-w-0 flex-col">
        <dt className={LABEL}>Won · {month.name}</dt>
        <dd className="contents">
          <span className={cn(FIGURE, "mt-1")}>{wins.won}</span>
          <span className={cn(DETAIL, "mt-0.5")}>
            {wins.decided === 0
              ? month.isCurrent
                ? "No deals decided yet"
                : "No deals decided"
              : `of ${wins.decided} decided`}
            {partial(wins.isPartial)}
          </span>
        </dd>
      </div>
    </dl>
  );
}

function BookZone({ summary, isPartial, filter, onFilter, setting, now, month }: BookPanelProps) {
  const segments = segmentsOf(summary);
  const active = filter.state !== null;
  const toggle = (segment: Segment) =>
    onFilter(
      isSelected(segment, filter)
        ? { ...filter, state: null, age: null }
        : { ...filter, ...segment.filter },
    );
  const stages = [
    ["Booked", summary.positions.booked],
    ["Call held", summary.positions.call_held],
    ["Follow-up", summary.positions.follow_up],
  ] as const;

  return (
    <div className={ZONE}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 className={LABEL}>{month.isCurrent ? "Open deals" : "Open deals now"}</h2>
        <span className={FIGURE}>
          {summary.total}
          {isPartial ? "+" : ""}
        </span>
        {summary.total > 0 ? (
          <span className="text-[13px] text-board-muted">
            {stages
              .filter(([, count]) => count > 0)
              .map(([label, count]) => `${label} ${count}`)
              .join(" · ")}
          </span>
        ) : null}
      </div>

      {summary.total === 0 ? (
        <p className={cn(DETAIL, "mt-2")}>
          No open deals. A deal opens here when someone books a call with you.
        </p>
      ) : (
        <>
          {/* The bar is a pointer shortcut; the legend under it is the keyboard path. */}
          <div aria-hidden="true" className="mt-3 flex h-3.5 gap-0.5 overflow-hidden rounded-[3px]">
            {segments
              .filter((segment) => segment.count > 0)
              .map((segment) => (
                <button
                  key={segment.key}
                  type="button"
                  tabIndex={-1}
                  onClick={() => toggle(segment)}
                  style={{ flexGrow: segment.count }}
                  className={cn(
                    "min-w-1 basis-0 cursor-pointer transition-opacity duration-200",
                    segment.fill,
                    active && !isSelected(segment, filter) && "opacity-35",
                  )}
                />
              ))}
          </div>
          <ul aria-label="Filter open deals by where they stand" className="mt-2 flex flex-wrap gap-x-1 gap-y-0.5">
            {segments.map((segment) => {
              const selected = isSelected(segment, filter);
              // An empty age band says nothing; Ahead and No next step always show.
              if (segment.count === 0 && !selected && segment.filter.age !== null) return null;
              return (
                <li key={segment.key}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    disabled={segment.count === 0 && !selected}
                    onClick={() => toggle(segment)}
                    className={cn(
                      "-ml-1.5 inline-flex min-h-6 items-center gap-1.5 rounded-[5px] px-1.5 text-[13px] text-board-foreground/80 outline-none hover:bg-board-raised focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                      selected && "bg-board-raised text-board-foreground",
                    )}
                  >
                    <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-[2px]", segment.fill)} />
                    {segment.label}
                    <span className="font-condensed text-sm font-semibold tabular-nums">{segment.count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className={cn(DETAIL, "mt-2.5")}>
            {summary.notRecorded === 0 ? (
              summary.noStep === 0 ? (
                "Every open deal has a next step."
              ) : (
                <>
                  <span className="font-semibold text-warning">{summary.noStep}</span>{" "}
                  {summary.noStep === 1 ? "deal has" : "deals have"} no next step.
                </>
              )
            ) : (
              <>
                <span className="font-semibold text-warning">{summary.notRecorded}</span>{" "}
                {summary.notRecorded === 1 ? "call" : "calls"} passed with no outcome recorded
                {summary.oldestMissedAt !== null ? (
                  <>
                    , the oldest on{" "}
                    <span className="font-condensed text-sm font-semibold tabular-nums">
                      {personDate(summary.oldestMissedAt, setting, now)}
                    </span>
                  </>
                ) : null}
                .
              </>
            )}
            {isPartial ? " Your oldest open deals aren't counted." : null}
          </p>
        </>
      )}
    </div>
  );
}

// On a phone the table keeps Open and Not recorded; Won and Cash are in the month above.
const PROGRAM_GRID =
  "grid grid-cols-[minmax(0,1fr)_2.5rem_5.75rem] items-center gap-x-3 @md/book:grid-cols-[minmax(0,1fr)_2.5rem_5.75rem_2.5rem_minmax(3.5rem,auto)]";
const WIDE_ONLY = "hidden @md/book:block";

function ProgramsZone({ programs, filter, onFilter, month }: BookPanelProps) {
  const [showAll, setShowAll] = useState(false);
  if (programs.length === 0) return null;
  const shown = showAll ? programs : programs.slice(0, PROGRAMS_SHOWN);
  const hidden = programs.length - shown.length;

  return (
    <div className={cn(ZONE, "@4xl/book:col-span-2 @4xl/book:border-t @4xl/book:border-l-0 @4xl/book:[&>*]:max-w-xl @5xl/book:col-span-1 @5xl/book:border-t-0 @5xl/book:border-l @5xl/book:[&>*]:max-w-none")}>
      <div className={cn(PROGRAM_GRID, LABEL, "min-h-5 text-right [&>:first-child]:text-left")}>
        <h2>Programs</h2>
        <span>Open</span>
        <span>Not recorded</span>
        <span className={WIDE_ONLY}>Won</span>
        <span className={WIDE_ONLY}>Cash</span>
      </div>
      <ul className="mt-1">
        {shown.map((program) => {
          const selected = filter.programKey === program.key;
          const name = programLabel(program.name);
          const cash = program.cash[0];
          return (
            <li key={program.key} className="border-t border-board-line first:border-t-0">
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`${name}: ${program.open} open, ${program.notRecorded} not recorded, ${program.won} won and ${cash ? formatCash(cash.amountMinor, cash.currency) : "no cash"} in ${month.name}`}
                onClick={() => onFilter({ ...filter, programKey: selected ? null : program.key })}
                className={cn(
                  PROGRAM_GRID,
                  "-mx-2 min-h-7 w-[calc(100%+1rem)] rounded-[5px] px-2 text-right text-[13px] outline-none hover:bg-board-raised focus-visible:ring-2 focus-visible:ring-ring",
                  selected && "bg-board-raised",
                )}
              >
                <span className={cn("truncate text-left", program.name === null && "text-board-muted")}>
                  {selected ? <span className="mr-1.5 inline-block size-1.5 rounded-full bg-board-foreground align-middle" /> : null}
                  {name}
                </span>
                <Count value={program.open} />
                <Count value={program.notRecorded} warn />
                <Count value={program.won} className={WIDE_ONLY} />
                <span className={cn(WIDE_ONLY, "font-condensed text-sm font-semibold tabular-nums", !cash && "text-board-muted")}>
                  {cash ? formatCash(cash.amountMinor, cash.currency) : "—"}
                  {program.cash.length > 1 ? <span className="text-board-muted"> +{program.cash.length - 1}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {hidden > 0 || showAll ? (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="mt-1 -ml-1.5 inline-flex min-h-6 items-center self-start rounded-[5px] px-1.5 text-[13px] text-board-muted outline-none hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showAll ? "Show fewer" : `${hidden} more ${hidden === 1 ? "program" : "programs"}`}
        </button>
      ) : null}
    </div>
  );
}

function Count({ value, warn, className }: { value: number; warn?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "font-condensed text-sm font-semibold tabular-nums",
        className,
        value === 0 ? "text-board-muted" : warn ? "text-warning" : undefined,
      )}
    >
      {value}
    </span>
  );
}
