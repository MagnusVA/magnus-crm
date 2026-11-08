"use client";

import { Fragment, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDownIcon } from "lucide-react";
import { DetailCardFooter, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { getMemberDisplayName } from "@/app/workspace/_components/member-avatar";
import { ATTENDANCE_COUNTS_PARTIAL_HELP } from "@/app/workspace/_components/results-recorded";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";
import { COLUMN_HEAD, FIGURE_15, ReportCard, ReportNote, RowsSkeleton, TOTAL_ROW } from "../../_components/report-ui";
import type { CallMetrics, CloserData, TeamPerformanceMetrics, TeamTotals } from "./team-report-types";
import {
  CLOSER_CLOSE_RATE_HELP,
  cohortCloseRate,
  dealsWonWords,
  formatCount,
  formatMoney,
  formatRate,
  plural,
  resultsWords,
} from "./team-report-formatters";

// Each closer's calls and payments, ranked by revenue (DESIGN.md, The Phone
// Closers Table, Ranked by revenue). New and follow-up calls are the same
// rollup split by call type, so one tab row switches the call columns; the
// payment columns belong to the closer and stay put. From @5xl/closers every
// column shows; from @3xl/closers Canceled and Avg sale fold into the proof
// line under the name; narrower each closer is two lines that open in place.

type CallType = "new" | "follow_up";

const TABS: Array<{ value: CallType; label: string }> = [
  { value: "new", label: "New calls" },
  { value: "follow_up", label: "Follow-up calls" },
];

type Row = {
  key: string;
  name: string;
  calls: CallMetrics;
  sales: number;
  revenueMinor: number;
  adminMinor: number;
  closeRate: ReturnType<typeof cohortCloseRate>;
  avgMinor: number | null;
};

function closerRow(closer: CloserData, callType: CallType): Row {
  return {
    key: closer.closerId,
    name: getMemberDisplayName(closer.closer),
    calls: callType === "new" ? closer.newCalls : closer.followUpCalls,
    sales: closer.sales,
    revenueMinor: closer.cashCollectedMinor,
    adminMinor: closer.adminLoggedRevenueMinor,
    closeRate: cohortCloseRate(closer),
    avgMinor: closer.avgCashCollectedMinor,
  };
}

function totalRow(totals: TeamTotals, callType: CallType): Row {
  const isNew = callType === "new";
  const showed = isNew ? totals.newShowed : totals.followUpShowed;
  const noShows = isNew ? totals.newNoShows : totals.followUpNoShows;
  return {
    key: "total",
    name: "Total",
    calls: {
      bookedCalls: isNew ? totals.newBookedCalls : totals.followUpBookedCalls,
      canceledCalls: isNew ? totals.newCanceled : totals.followUpCanceled,
      noShows,
      callsShowed: showed,
      showUpRate: isNew ? totals.newShowUpRate : totals.followUpShowUpRate,
      resultsRecorded: showed + noShows,
      pastCalls: isNew ? totals.newPastCalls : totals.followUpPastCalls,
      confirmedAttendanceDenominator: isNew
        ? totals.newConfirmedAttendanceDenominator
        : totals.followUpConfirmedAttendanceDenominator,
    },
    sales: totals.totalSales,
    revenueMinor: totals.totalRevenueMinor,
    adminMinor: totals.totalAdminLoggedRevenueMinor,
    closeRate: cohortCloseRate({ closeRate: totals.overallCloseRate, cohortDeals: totals.cohortDeals, wonDeals: totals.wonDeals }),
    avgMinor: totals.totalSales > 0 ? totals.totalRevenueMinor / totals.totalSales : null,
  };
}

/** A closer with no calls of either type, no past calls, deals or payments. */
function isQuiet(closer: CloserData) {
  const calls = [closer.newCalls, closer.followUpCalls];
  return (
    calls.every((entry) => entry.bookedCalls === 0 && entry.pastCalls === 0) &&
    closer.sales === 0 &&
    closer.cashCollectedMinor === 0 &&
    !closer.cohortDeals
  );
}

type Column = {
  key: string;
  head: string;
  /** Hidden below @5xl/closers, where the proof line carries it. */
  wideOnly?: boolean;
  help?: string;
  value: (row: Row) => string;
  quietAtZero?: (row: Row) => boolean;
};

const COLUMNS: Column[] = [
  { key: "booked", head: "Booked", value: (row) => formatCount(row.calls.bookedCalls) },
  {
    key: "canceled",
    head: "Canceled",
    wideOnly: true,
    value: (row) => formatCount(row.calls.canceledCalls),
    quietAtZero: (row) => row.calls.canceledCalls === 0,
  },
  {
    key: "noShows",
    head: "No-show",
    value: (row) => formatCount(row.calls.noShows),
    quietAtZero: (row) => row.calls.noShows === 0,
  },
  { key: "held", head: "Held", value: (row) => formatCount(row.calls.callsShowed) },
  { key: "showRate", head: "Show rate", value: (row) => formatRate(row.calls.showUpRate) },
  { key: "closeRate", head: "Close rate", help: CLOSER_CLOSE_RATE_HELP, value: (row) => formatRate(row.closeRate.rate) },
  {
    key: "sales",
    head: "Payment sales",
    value: (row) => formatCount(row.sales),
    quietAtZero: (row) => row.sales === 0,
  },
  {
    key: "revenue",
    head: "Revenue",
    value: (row) => formatMoney(row.revenueMinor),
    quietAtZero: (row) => row.revenueMinor === 0,
  },
  {
    key: "avg",
    head: "Avg sale",
    wideOnly: true,
    value: (row) => (row.avgMinor === null ? "—" : formatMoney(row.avgMinor)),
  },
];

/** The 13px line under a name: results, deals won, admin-logged cash, then what the middle width folds in. */
function ProofLine({ row, partial, total }: { row: Row; partial: boolean; total?: boolean }) {
  const won = dealsWonWords(row.closeRate);
  const parts = [
    resultsWords(row.calls, partial),
    won && (total || (row.closeRate.cohortDeals ?? 0) > 0) ? won : null,
    row.adminMinor > 0 ? `${formatMoney(row.adminMinor)} logged by an admin` : null,
  ].filter((part): part is string => part !== null);
  const folded = [
    `${formatCount(row.calls.canceledCalls)} canceled`,
    row.avgMinor === null ? null : `avg sale ${formatMoney(row.avgMinor)}`,
  ].filter((part): part is string => part !== null);
  return (
    <p className={cn("text-[13px] text-muted-foreground", total && "font-normal")}>
      {parts.join(" · ")}
      <span className="@5xl/closers:hidden">
        {folded.map((part) => (
          <Fragment key={part}>
            {" · "}
            <span className="whitespace-nowrap">{part}</span>
          </Fragment>
        ))}
      </span>
    </p>
  );
}

function FigureCells({ row, total }: { row: Row; total?: boolean }) {
  return (
    <>
      {COLUMNS.map((column, index) => (
        <td
          key={column.key}
          className={cn(
            "px-2.5 text-right whitespace-nowrap",
            FIGURE_15,
            column.wideOnly && "hidden @5xl/closers:table-cell",
            index === COLUMNS.length - 1 ? "pr-4" : column.key === "revenue" && "@max-5xl/closers:pr-4",
            !total && column.quietAtZero?.(row) && "text-muted-foreground",
          )}
        >
          {column.value(row)}
        </td>
      ))}
    </>
  );
}

/** One closer on a narrow card: name and revenue, then the short counts line; it opens to every figure. */
function NarrowRow({ row, partial, total }: { row: Row; partial: boolean; total?: boolean }) {
  const parts = [
    `${formatCount(row.calls.bookedCalls)} booked`,
    `${formatCount(row.calls.callsShowed)} held`,
    `${formatRate(row.calls.showUpRate)} show`,
    `${formatRate(row.closeRate.rate)} close`,
    plural(row.sales, "sale"),
  ];
  return (
    <details className="group">
      <summary className="-mx-4 -my-2.5 flex cursor-pointer list-none gap-2 px-4 py-2.5 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate font-semibold">{row.name}</span>
            <span className={cn(FIGURE_15, "shrink-0", !total && row.revenueMinor === 0 && "text-muted-foreground")}>
              {formatMoney(row.revenueMinor)}
            </span>
          </span>
          <span className="text-[13px] text-muted-foreground">
            {parts.map((part, index) => (
              <Fragment key={part}>
                {index > 0 ? " · " : null}
                <span className="whitespace-nowrap">{part}</span>
              </Fragment>
            ))}
          </span>
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
        {COLUMNS.map((column) => (
          <div key={column.key} className="flex items-baseline justify-between gap-2 border-b border-dashed py-0.5">
            <dt className="text-muted-foreground">{column.head}</dt>
            <dd className={cn(FIGURE_15, !total && column.quietAtZero?.(row) && "text-muted-foreground")}>{column.value(row)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[13px] text-muted-foreground">
        {[
          resultsWords(row.calls, partial),
          dealsWonWords(row.closeRate),
          row.adminMinor > 0 ? `${formatMoney(row.adminMinor)} logged by an admin` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </details>
  );
}

function ClosersTable({ rows, total, partial, callType }: { rows: Row[]; total: Row; partial: boolean; callType: CallType }) {
  return (
    <>
      <table className="hidden w-full border-collapse @3xl/closers:table">
        <caption className="sr-only">
          {callType === "new" ? "New" : "Follow-up"} calls and payments by phone closer, ranked by revenue
        </caption>
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
                  column.wideOnly && "hidden @5xl/closers:table-cell",
                  column.key === "noShows" && "whitespace-nowrap",
                  index === COLUMNS.length - 1 ? "pr-4" : column.key === "revenue" && "@max-5xl/closers:pr-4",
                )}
              >
                {column.help ? <HelpTip tip={column.help}>{column.head}</HelpTip> : column.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b">
              <th scope="row" className="py-2 pr-3 pl-4 text-left font-normal">
                <p className="font-semibold">{row.name}</p>
                <ProofLine row={row} partial={partial} />
              </th>
              <FigureCells row={row} />
            </tr>
          ))}
          <tr className={TOTAL_ROW}>
            <th scope="row" className="py-2 pr-3 pl-4 text-left">
              <p className="font-semibold">Total</p>
              <ProofLine row={total} partial={partial} total />
            </th>
            <FigureCells row={total} total />
          </tr>
        </tbody>
      </table>

      <ul aria-label="Calls and payments by phone closer" className="flex flex-col @3xl/closers:hidden">
        {rows.map((row) => (
          <li key={row.key} className="border-b px-4 py-2.5">
            <NarrowRow row={row} partial={partial} />
          </li>
        ))}
        <li className={cn("px-4 py-2.5", TOTAL_ROW)}>
          <NarrowRow row={total} partial={partial} total />
        </li>
      </ul>
    </>
  );
}

/** NEW CALLS · FOLLOW-UP CALLS on the white card: ink underline, arrow keys between them. */
function CallTypeTabs({
  value,
  onChange,
  counts,
  panelId,
}: {
  value: CallType;
  onChange: (value: CallType) => void;
  counts: Record<CallType, number> | null;
  panelId: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = (index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    onChange(TABS[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label="Call type" className="flex gap-[18px] border-b px-4">
      {TABS.map((tab, index) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "flex h-10 items-center gap-1.5 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected ? "text-foreground shadow-[inset_0_-2px_0_var(--color-foreground)]" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {counts ? <span className="tracking-normal tabular-nums">{formatCount(counts[tab.value])}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function CloserPerformanceCard({
  metrics,
  rangePhrase,
  reloading,
}: {
  metrics: TeamPerformanceMetrics | undefined;
  rangePhrase: string;
  reloading: boolean;
}) {
  const panelId = useId();
  const [callType, setCallType] = useState<CallType>("new");
  const [showQuiet, setShowQuiet] = useState(false);

  const ranked = useMemo(
    () =>
      metrics &&
      [...metrics.closers].sort(
        (left, right) =>
          right.cashCollectedMinor - left.cashCollectedMinor ||
          right.newCalls.bookedCalls + right.followUpCalls.bookedCalls - (left.newCalls.bookedCalls + left.followUpCalls.bookedCalls) ||
          getMemberDisplayName(left.closer).localeCompare(getMemberDisplayName(right.closer)),
      ),
    [metrics],
  );
  const active = ranked?.filter((closer) => !isQuiet(closer)) ?? [];
  const quiet = ranked?.filter(isQuiet) ?? [];
  const shown = (showQuiet ? [...active, ...quiet] : active).map((closer) => closerRow(closer, callType));
  const totals = metrics?.teamTotals;
  const counts = totals ? { new: totals.newBookedCalls, follow_up: totals.followUpBookedCalls } : null;
  const partial = metrics?.attendanceCountsPartial ?? false;

  return (
    <ReportCard
      title="Closer performance"
      meta="Ranked by revenue · Show rate: held ÷ (held + no-show)"
      container="@container/closers"
      reloading={reloading}
      footer={
        quiet.length > 0 ? (
          <DetailCardFooter className="font-normal">
            <span className="text-[13px]">
              {showQuiet
                ? `The last ${formatCount(quiet.length)} had no calls or payments ${rangePhrase}`
                : `${active.length > 0 ? `${formatCount(quiet.length)} more` : formatCount(quiet.length)} phone closer${quiet.length === 1 ? "" : "s"} had no calls or payments ${rangePhrase}`}
            </span>
            <button
              type="button"
              aria-expanded={showQuiet}
              className={cn(detailLinkClass, "text-[13px]")}
              onClick={() => setShowQuiet((value) => !value)}
            >
              {showQuiet ? "Hide them" : "Show them"}
            </button>
          </DetailCardFooter>
        ) : null
      }
    >
      <CallTypeTabs value={callType} onChange={setCallType} counts={counts} panelId={panelId} />
      <div role="tabpanel" id={panelId} aria-label={callType === "new" ? "New calls" : "Follow-up calls"}>
        {metrics === undefined || totals === undefined || ranked === undefined ? (
          <RowsSkeleton rows={6} rowHeight="h-[60px]" label="Loading closer performance" />
        ) : (
          <>
            {metrics.isPaymentDataTruncated ? (
              <ReportNote lead="Capped.">Payments in this range passed the reporting cap, so revenue may be approximate.</ReportNote>
            ) : null}
            {metrics.isCloseRateCohortTruncated ? (
              <ReportNote lead="Close rate unavailable.">
                This range has more held calls than the live close rate can read. Narrow the range to see it.
              </ReportNote>
            ) : null}
            {partial && shown.length > 0 ? <ReportNote lead="Partial.">{ATTENDANCE_COUNTS_PARTIAL_HELP}</ReportNote> : null}
            {ranked.length === 0 ? (
              <SectionEmpty title="No phone closers yet.">Closers appear here once they are on the team.</SectionEmpty>
            ) : shown.length === 0 ? (
              <SectionEmpty title={`No calls or payments for phone closers ${rangePhrase}.`} />
            ) : (
              <ClosersTable rows={shown} total={totalRow(totals, callType)} partial={partial} callType={callType} />
            )}
          </>
        )}
      </div>
    </ReportCard>
  );
}
