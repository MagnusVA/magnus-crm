"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { Id } from "@/convex/_generated/dataModel";
import type { FollowThroughOutput, FunnelOutput, OriginsOutput } from "@/convex/reports/scorecard";
import { LIFECYCLE_STAGE_LABELS } from "@/convex/leads/lifecycle";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { REPORT_TERMS, termHelp } from "@/lib/reporting/definitions";
import { cn } from "@/lib/utils";
import {
  BarList,
  COLUMN_HEAD,
  FIGURE_15,
  FIGURE_20,
  LABEL,
  ReportCard,
  ReportNote,
  RowsSkeleton,
  SINGLE_SERIES,
  TOTAL_ROW,
} from "../../_components/report-ui";
import { PageRows, ReportPager, usePagedRows } from "../../_components/report-paging";
import { memberReportHref } from "../../log/_components/use-team-members";
import { formatCount, formatMoney, formatShare, inCurrency } from "./report-money";
import {
  COHORT_STEPS,
  FUNNEL_PROGRAM_NOTE,
  FUNNEL_STAGES,
  PAYMENT_TYPES,
  cashPerWonDeal,
  channelLabel,
  groupByWeek,
  weekLabel,
  type CashCurrency,
} from "./scorecard-shape";

// The Scorecard's cards (docs/reviews/reports-overhaul.html §08). Each is a
// ruled ReportCard that reports its own loading, empty and reloading state.

/** The 30px segmented toggle on the muted track (The Programs Card's view switch). */
export function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (next: Value) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as Value);
      }}
      aria-label={label}
      className="h-[30px] rounded-[7px] bg-muted p-0.5"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="h-full rounded-[5px]! px-2.5 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** A small label row inside a card, over the rows it names. */
function SubHead({ children }: { children: ReactNode }) {
  return <p className={cn(LABEL, "border-b px-4 py-2")}>{children}</p>;
}

/** One ruled fact line: a label (with its help) and a figure on the right. */
function FactRow({ label, help, value, meta }: { label: string; help?: string; value: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 border-b px-4 py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="font-medium">{help ? <HelpTip tip={help}>{label}</HelpTip> : label}</p>
        {meta ? <p className="text-[13px] text-muted-foreground">{meta}</p> : null}
      </div>
      <p className={cn(FIGURE_15, "text-right whitespace-nowrap")}>{value}</p>
    </div>
  );
}

// ─── The funnel ──────────────────────────────────────────────────────────────

type FunnelView = "range" | "cohort";

export function FunnelCard({
  funnel,
  reloading,
  phrase,
  programSelected,
}: {
  funnel: FunnelOutput | undefined;
  reloading: boolean;
  phrase: string;
  /** A program is picked: the people counts still cover every program. */
  programSelected: boolean;
}) {
  const programNote = programSelected ? <ReportNote>{FUNNEL_PROGRAM_NOTE}</ReportNote> : null;
  const [view, setView] = useState<FunnelView>("range");
  const empty =
    funnel !== undefined &&
    FUNNEL_STAGES.every((stage) => funnel.stages[stage] === 0) &&
    funnel.cohort.entered === 0;
  return (
    <ReportCard
      title="The funnel"
      container="@container/funnel"
      reloading={reloading}
      meta={
        <Segmented
          label="Count the funnel"
          value={view}
          onChange={setView}
          options={[
            { value: "range", label: "In this range" },
            { value: "cohort", label: "Cohort" },
          ]}
        />
      }
    >
      {funnel === undefined ? (
        <RowsSkeleton rows={6} label="Loading the funnel" />
      ) : empty ? (
        <SectionEmpty title={`No one entered the funnel ${phrase}.`}>People count here as they move through their lifecycle stages.</SectionEmpty>
      ) : view === "range" ? (
        <>
          <ReportNote lead="In this range.">
            Each step counts the people who entered it {phrase}, so the steps can be different people.
          </ReportNote>
          {programNote}
          <BarList
            label="People entering each stage"
            labelColumn="11rem"
            rows={FUNNEL_STAGES.map((stage) => ({
              key: stage,
              label: LIFECYCLE_STAGE_LABELS[stage],
              value: funnel.stages[stage],
              display: formatCount(funnel.stages[stage]),
            }))}
          />
        </>
      ) : (
        <>
          <ReportNote lead="Cohort.">
            The people who entered In conversation {phrase}, and how many of them have reached each stage by now.
          </ReportNote>
          {programNote}
          {funnel.cohort.entered === 0 ? (
            <SectionEmpty title={`No one entered In conversation ${phrase}.`} />
          ) : (
            <BarList
              label="The cohort by stage reached"
              labelColumn="11rem"
              rows={COHORT_STEPS.map((step) => ({
                key: step.key,
                label: step.label,
                meta: step.key === "entered" ? "The cohort" : `${formatShare(funnel.cohort[step.key], funnel.cohort.entered)} of the cohort`,
                value: funnel.cohort[step.key],
                display: formatCount(funnel.cohort[step.key]),
              }))}
            />
          )}
        </>
      )}
    </ReportCard>
  );
}

// ─── Cash ────────────────────────────────────────────────────────────────────

export function CashCard({
  entry,
  loaded,
  currency,
  reloading,
  phrase,
}: {
  /** The shown currency's cash, undefined when there is none in it. */
  entry: CashCurrency | undefined;
  loaded: boolean;
  currency: string;
  reloading: boolean;
  phrase: string;
}) {
  const perDeal = entry ? cashPerWonDeal(entry) : null;
  return (
    <ReportCard
      title={REPORT_TERMS.cash.label}
      meta={loaded ? currency : undefined}
      container="@container/cash"
      reloading={reloading}
    >
      {!loaded ? (
        <RowsSkeleton rows={6} label="Loading cash" />
      ) : !entry || entry.cashMinor === 0 ? (
        <SectionEmpty title={`No payments in ${currency} ${phrase}.`}>Disputed payments never count.</SectionEmpty>
      ) : (
        <>
          {/* Payment types beside the facts once the card is wide enough for
              both, so Cash stands about as tall as the Funnel beside it. Each
              column is its own container, so the bars fold by its width. */}
          <div className="grid @lg/cash:grid-cols-2 @lg/cash:divide-x">
            <div className="@container min-w-0 border-b @lg/cash:border-b-0">
              <SubHead>By payment type</SubHead>
              <BarList
                label="Cash by payment type"
                labelColumn="8rem"
                rows={PAYMENT_TYPES.map((type) => ({
                  key: type.key,
                  label: type.label,
                  meta: formatShare(entry.byType[type.key], entry.cashMinor),
                  value: entry.byType[type.key],
                  display: formatMoney(entry.byType[type.key], currency),
                }))}
              />
            </div>
            <div className="min-w-0">
              <FactRow
                label={REPORT_TERMS.finalCash.label}
                help={termHelp("finalCash")}
                value={formatMoney(entry.finalMinor, currency)}
              />
              <FactRow label="Deposits" meta="Part of cash, not of final cash" value={formatMoney(entry.depositMinor, currency)} />
              <FactRow
                label="Deposits on lost deals"
                meta="Deposits in the range on deals that are lost now"
                value={formatMoney(entry.depositsOnLostDeals, currency)}
              />
              <FactRow
                label={REPORT_TERMS.cashPerWonDeal.label}
                help={termHelp("cashPerWonDeal")}
                meta={
                  perDeal === null
                    ? "No deal won to divide by"
                    : `${formatMoney(entry.finalOnWonDealsMinor, currency)} ÷ ${formatCount(entry.dealsWon)} deal${entry.dealsWon === 1 ? "" : "s"} won`
                }
                value={perDeal === null ? "—" : formatMoney(perDeal, currency)}
              />
            </div>
          </div>
        </>
      )}
    </ReportCard>
  );
}

// ─── Week by week ────────────────────────────────────────────────────────────

type WeekMeasure = { key: string; label: string; help?: string; values: number[]; display: (value: number) => string };

/** One measure as a row of week bars, scaled to its largest week. */
function WeekMultiple({ measure, weeks }: { measure: WeekMeasure; weeks: ReturnType<typeof groupByWeek> }) {
  const max = Math.max(...measure.values, 0);
  const total = measure.values.reduce((sum, value) => sum + value, 0);
  return (
    <div className="flex min-w-0 flex-col gap-2 bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className={LABEL}>{measure.help ? <HelpTip tip={measure.help}>{measure.label}</HelpTip> : measure.label}</p>
        <p className={FIGURE_20}>{measure.display(total)}</p>
      </div>
      <ul aria-label={`${measure.label} by week`} className="flex h-20 items-end gap-1">
        {weeks.map((week, index) => {
          const value = measure.values[index];
          return (
            <li key={week.weekStart} className="flex h-full min-w-0 flex-1 items-end" title={`${weekLabel(week)}: ${measure.display(value)}`}>
              <span className="sr-only">
                {weekLabel(week)}
                {week.partial ? " (part of a week)" : ""}: {measure.display(value)}
              </span>
              <span
                aria-hidden="true"
                className="w-full rounded-t-[3px]"
                style={{
                  height: max > 0 ? `${Math.max((value / max) * 100, value > 0 ? 3 : 0)}%` : 0,
                  background: SINGLE_SERIES,
                  opacity: week.partial ? 0.45 : 1,
                }}
              />
            </li>
          );
        })}
      </ul>
      <div aria-hidden="true" className="flex justify-between gap-2 text-[12px] text-muted-foreground">
        <span className="truncate">{weeks[0] ? weekLabel(weeks[0]) : null}</span>
        {weeks.length > 1 ? <span className="truncate">{weekLabel(weeks[weeks.length - 1])}</span> : null}
      </div>
    </div>
  );
}

export function WeeksCard({
  funnel,
  currency,
  reloading,
  phrase,
}: {
  funnel: FunnelOutput | undefined;
  currency: string;
  reloading: boolean;
  phrase: string;
}) {
  const weeks = funnel ? groupByWeek(funnel.byDay) : [];
  const measures: WeekMeasure[] = [
    {
      key: "bookings",
      label: REPORT_TERMS.bookingsMade.label,
      help: termHelp("bookingsMade"),
      values: weeks.map((week) => week.bookingsMade),
      display: formatCount,
    },
    { key: "held", label: "Calls held", values: weeks.map((week) => week.callsHeld), display: formatCount },
    {
      key: "won",
      label: REPORT_TERMS.dealsWon.label,
      help: termHelp("dealsWon"),
      values: weeks.map((week) => week.dealsWon),
      display: formatCount,
    },
    {
      key: "cash",
      label: `${REPORT_TERMS.cash.label} · ${currency}`,
      help: termHelp("cash"),
      values: weeks.map((week) => inCurrency(week.cash, currency)?.cashMinor ?? 0),
      display: (value) => formatMoney(value, currency),
    },
  ];
  const partial = weeks.some((week) => week.partial);
  return (
    <ReportCard
      title="Week by week"
      meta="Monday to Sunday, business days"
      container="@container/weeks"
      reloading={reloading}
    >
      {funnel === undefined ? (
        <RowsSkeleton rows={4} rowHeight="h-16" label="Loading the weeks" />
      ) : weeks.length === 0 ? (
        <SectionEmpty title={`No days ${phrase}.`} />
      ) : (
        <>
          {partial ? (
            <ReportNote>Weeks cut by the range&apos;s start or end are drawn lighter.</ReportNote>
          ) : null}
          <div className="grid gap-px bg-border @xl/weeks:grid-cols-2 @5xl/weeks:grid-cols-4">
            {measures.map((measure) => (
              <WeekMultiple key={measure.key} measure={measure} weeks={weeks} />
            ))}
          </div>
        </>
      )}
    </ReportCard>
  );
}

// ─── Follow-through ──────────────────────────────────────────────────────────

const FOLLOW_COLUMNS = "grid-cols-[minmax(0,1fr)_repeat(3,4.5rem)] @2xl/follow:grid-cols-[minmax(0,1fr)_repeat(5,5.5rem)]";

export function FollowThroughCard({
  data,
  reloading,
  phrase,
  programKey,
  memberFor,
}: {
  data: FollowThroughOutput | undefined;
  reloading: boolean;
  phrase: string;
  /** The band's program filter, which the pager starts over on. */
  programKey: string;
  /** The closer's team member, when their login is linked to one. */
  memberFor: (userId: Id<"users">) => Id<"teamMembers"> | undefined;
}) {
  const closers = data ? [...data.byCloser].sort((a, b) => b.due - a.due || a.name.localeCompare(b.name)) : [];
  const { rows: shownClosers, pager } = usePagedRows(closers, { resetKey: programKey });
  return (
    <ReportCard
      title="Follow-through"
      meta={data ? `${formatCount(data.due)} reminder${data.due === 1 ? "" : "s"} due` : undefined}
      container="@container/follow"
      reloading={reloading}
      footer={data === undefined || data.due === 0 ? undefined : <ReportPager pager={pager} noun="closers" />}
    >
      {data === undefined ? (
        <RowsSkeleton rows={5} label="Loading follow-through" />
      ) : data.due === 0 ? (
        <SectionEmpty title={`No reminders were due ${phrase}.`}>Manual reminders count here on the day they&apos;re due.</SectionEmpty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-px border-b bg-border @lg/follow:grid-cols-4">
            {[
              { label: REPORT_TERMS.tasksOnTime.label, help: termHelp("tasksOnTime"), value: formatShare(data.onTime, data.due) },
              { label: "On time", value: formatCount(data.onTime) },
              { label: "Late", value: formatCount(data.late) },
              { label: "Overdue now", value: formatCount(data.openOverdue), owed: data.openOverdue > 0 },
            ].map((cell) => (
              <div key={cell.label} className="flex flex-col gap-1 bg-card px-4 py-3">
                <p className={LABEL}>{cell.help ? <HelpTip tip={cell.help}>{cell.label}</HelpTip> : cell.label}</p>
                <p className={cn(FIGURE_20, cell.owed && "text-warning-ink")}>{cell.value}</p>
              </div>
            ))}
          </div>
          <PageRows pager={pager}>
            <div role="table" aria-label="Follow-through by closer">
              <div role="row" className={cn("grid border-b", FOLLOW_COLUMNS)}>
                <span role="columnheader" className={cn(COLUMN_HEAD, "pl-4")}>
                  Closer
                </span>
                <span role="columnheader" className={cn(COLUMN_HEAD, "text-right")}>
                  Due
                </span>
                <span role="columnheader" className={cn(COLUMN_HEAD, "hidden text-right @2xl/follow:block")}>
                  On time
                </span>
                <span role="columnheader" className={cn(COLUMN_HEAD, "hidden text-right @2xl/follow:block")}>
                  Late
                </span>
                <span role="columnheader" className={cn(COLUMN_HEAD, "text-right")}>
                  Overdue
                </span>
                <span role="columnheader" className={cn(COLUMN_HEAD, "pr-4 text-right")}>
                  On time
                </span>
              </div>
              {shownClosers.map((closer) => {
                const member = memberFor(closer.userId);
                return (
                  <div role="row" key={closer.userId} className={cn("grid min-h-11 items-center border-b last:border-b-0", FOLLOW_COLUMNS)}>
                    <span role="cell" className="min-w-0 truncate pr-3 pl-4 font-medium">
                      {member ? (
                        <Link href={memberReportHref(member)} className={detailLinkClass}>
                          {closer.name}
                        </Link>
                      ) : (
                        closer.name
                      )}
                    </span>
                    <span role="cell" className={cn(FIGURE_15, "px-2.5 text-right")}>
                      {formatCount(closer.due)}
                    </span>
                    <span role="cell" className={cn(FIGURE_15, "hidden px-2.5 text-right @2xl/follow:block")}>
                      {formatCount(closer.onTime)}
                    </span>
                    <span role="cell" className={cn(FIGURE_15, "hidden px-2.5 text-right @2xl/follow:block")}>
                      {formatCount(closer.late)}
                    </span>
                    <span
                      role="cell"
                      className={cn(FIGURE_15, "px-2.5 text-right", closer.openOverdue > 0 ? "text-warning-ink" : "text-muted-foreground")}
                    >
                      {formatCount(closer.openOverdue)}
                    </span>
                    <span role="cell" className={cn(FIGURE_15, "pr-4 pl-2.5 text-right")}>
                      {formatShare(closer.onTime, closer.due)}
                    </span>
                  </div>
                );
              })}
            </div>
          </PageRows>
        </>
      )}
    </ReportCard>
  );
}

// ─── Where the business came from ────────────────────────────────────────────

export function OriginsCard({
  data,
  currency,
  reloading,
  phrase,
}: {
  data: OriginsOutput | undefined;
  currency: string;
  reloading: boolean;
  phrase: string;
}) {
  const rows = data?.origins ?? [];
  const byCash = rows.some((origin) => (inCurrency(origin.cash, currency)?.cashMinor ?? 0) !== 0);
  return (
    <ReportCard
      title="Where the business came from"
      meta="First touch, frozen on the deal"
      container="@container/origins"
      reloading={reloading}
    >
      {data === undefined ? (
        <RowsSkeleton rows={5} label="Loading where the business came from" />
      ) : rows.length === 0 ? (
        <SectionEmpty title={`No deals won and no cash ${phrase}.`} />
      ) : (
        <>
          {!byCash ? <ReportNote>No cash in {currency} {phrase}, so channels are measured by deals won.</ReportNote> : null}
          <BarList
            label="Deals won and cash by first-touch channel"
            labelColumn="9rem"
            rows={[...rows]
              .map((origin) => ({ origin, cash: inCurrency(origin.cash, currency)?.cashMinor ?? 0 }))
              .sort((a, b) => (byCash ? b.cash - a.cash : 0) || b.origin.dealsWon - a.origin.dealsWon)
              .map(({ origin, cash }) => ({
                key: origin.channel,
                label: channelLabel(origin.channel),
                meta: `${formatCount(origin.dealsWon)} deal${origin.dealsWon === 1 ? "" : "s"} won`,
                value: byCash ? cash : origin.dealsWon,
                display: byCash ? formatMoney(cash, currency) : formatCount(origin.dealsWon),
              }))}
          />
        </>
      )}
    </ReportCard>
  );
}

// ─── Programs ────────────────────────────────────────────────────────────────

export function ProgramsTableCard({
  entry,
  loaded,
  currency,
  reloading,
  phrase,
  programKey,
}: {
  entry: CashCurrency | undefined;
  loaded: boolean;
  currency: string;
  reloading: boolean;
  phrase: string;
  /** The band's program filter, which the pager starts over on. */
  programKey: string;
}) {
  const programs = entry ? [...entry.byProgram].sort((a, b) => b.cashMinor - a.cashMinor || a.name.localeCompare(b.name)) : [];
  // One page of programs; the Total row under them stays on every page and
  // totals every program.
  const { rows: shownPrograms, pager } = usePagedRows(programs, { resetKey: `${currency}|${programKey}` });
  const numberCell = (value: ReactNode, extra?: string) => <td className={cn(FIGURE_15, "px-2.5 text-right whitespace-nowrap", extra)}>{value}</td>;
  return (
    <ReportCard
      title="Programs"
      meta={loaded ? `Cash by sold program · ${currency}` : undefined}
      container="@container/programs"
      reloading={reloading}
      footer={!loaded || programs.length === 0 || !entry ? undefined : <ReportPager pager={pager} noun="programs" />}
    >
      {!loaded ? (
        <RowsSkeleton rows={4} label="Loading programs" />
      ) : programs.length === 0 || !entry ? (
        <SectionEmpty title={`No payments in ${currency} ${phrase}.`} />
      ) : (
        <PageRows pager={pager}>
          <table className="w-full border-collapse">
            <caption className="sr-only">Payments, deals won and cash by program, in {currency}</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
                  Program
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "hidden text-right @2xl/programs:table-cell")}>
                  Payments
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                  Won
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                  {REPORT_TERMS.cash.label}
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "hidden text-right @2xl/programs:table-cell")}>
                  {REPORT_TERMS.finalCash.label}
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "pr-4 text-right")}>
                  <HelpTip tip={termHelp("cashPerWonDeal")}>Per won deal</HelpTip>
                </th>
              </tr>
            </thead>
            <tbody>
              {shownPrograms.map((program) => {
                const perDeal = cashPerWonDeal(program);
                return (
                  <tr key={program.programId} className="h-11 border-b">
                    <th scope="row" className="max-w-0 truncate pr-3 pl-4 text-left font-medium">
                      {program.name}
                    </th>
                    {numberCell(formatCount(program.payments), "hidden @2xl/programs:table-cell")}
                    {numberCell(formatCount(program.dealsWon))}
                    {numberCell(formatMoney(program.cashMinor, currency))}
                    {numberCell(formatMoney(program.finalMinor, currency), "hidden @2xl/programs:table-cell")}
                    {numberCell(perDeal === null ? "—" : formatMoney(perDeal, currency), "pr-4")}
                  </tr>
                );
              })}
              <tr className={cn("h-11", TOTAL_ROW)}>
                <th scope="row" className="pr-3 pl-4 text-left">
                  Total
                </th>
                {numberCell(formatCount(programs.reduce((sum, program) => sum + program.payments, 0)), "hidden @2xl/programs:table-cell")}
                {numberCell(formatCount(entry.dealsWon))}
                {numberCell(formatMoney(entry.cashMinor, currency))}
                {numberCell(formatMoney(entry.finalMinor, currency), "hidden @2xl/programs:table-cell")}
                {numberCell(cashPerWonDeal(entry) === null ? "—" : formatMoney(cashPerWonDeal(entry)!, currency), "pr-4")}
              </tr>
            </tbody>
          </table>
        </PageRows>
      )}
    </ReportCard>
  );
}
