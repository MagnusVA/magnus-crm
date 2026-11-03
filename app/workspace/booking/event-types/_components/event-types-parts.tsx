"use client";

import { ChevronDownIcon, RefreshCwIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CalendlyDot } from "../../_components/calendly-dot";
import { modeLabel, modeOf, type CoverageProgram } from "../../_components/booking-model";
import type { EventTypeFilter, EventTypeRow, Tone } from "../../_components/event-types/event-type-rows";

export const WORD = "font-condensed text-xs leading-none font-bold tracking-[0.08em] whitespace-nowrap uppercase";
export const LABEL = "font-condensed text-[11px] leading-[1.2] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

export const TONE: Record<Tone, string> = {
  ok: "text-foreground",
  slate: "text-stage-held",
  danger: "text-danger-ink",
  warn: "text-warning-ink",
  blue: "text-stage-booked-ink",
  plain: "text-foreground",
};

/**
 * The table's columns by the card's width (`@container/et`): the full
 * concept C row from `@4xl`; IN PORTAL and SCHEDULING fold away below it and
 * BOOKABLE below `@2xl`, where a row keeps the checkbox, name, program and
 * 30-day figure.
 */
export const ROW_GRID =
  "grid grid-cols-[30px_minmax(0,1fr)_minmax(110px,0.8fr)_44px] items-center gap-x-2.5 px-4 @2xl/et:grid-cols-[30px_minmax(0,2.2fr)_minmax(130px,1.1fr)_112px_52px] @4xl/et:grid-cols-[30px_minmax(0,2.5fr)_minmax(130px,1.15fr)_86px_118px_112px_58px]";
export const COL_SCHEDULING = "hidden @4xl/et:block";
export const COL_BOOKABLE = "hidden @2xl/et:block";
export const COL_PORTAL = "hidden @4xl/et:block";

const TABS: Array<{ id: EventTypeFilter; label: string }> = [
  { id: "sales", label: "Sales calls" },
  { id: "unsorted", label: "Unsorted" },
  { id: "looks", label: "Look-alikes" },
  { id: "not_sales_call", label: "Not sales calls" },
  { id: "gone", label: "Gone" },
  { id: "all", label: "All" },
];

export type FilterCounts = {
  sales: number;
  unsorted: number;
  looks: number;
  fold: number;
  not_sales_call: number;
  gone: number;
  all: number;
};

/** Search on the left, then the filter tabs with their counts. */
export function EventTypeTools({
  query,
  onQuery,
  filter,
  onFilter,
  counts,
}: {
  query: string;
  onQuery: (value: string) => void;
  filter: EventTypeFilter;
  onFilter: (filter: EventTypeFilter) => void;
  counts: FilterCounts;
}) {
  return (
    <div className="flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4">
      <label className="my-1.5 flex h-8 w-60 max-w-full items-center gap-2 rounded-[7px] border border-input px-2.5 text-muted-foreground focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <SearchIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">Search event types</span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search event types"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      <div role="tablist" aria-label="Show" className="flex flex-wrap gap-x-[18px] self-stretch">
        {TABS.map((tab) => {
          const count = tab.id === "looks" ? (counts.fold > 0 ? `${counts.fold} to fold` : counts.looks) : counts[tab.id];
          const amber = (tab.id === "unsorted" && counts.unsorted > 0) || (tab.id === "looks" && counts.fold > 0);
          const on = filter === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onFilter(tab.id)}
              className={cn(
                "flex h-[46px] items-center gap-1.5 border-b-2 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                on ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              <span
                className={cn(
                  "rounded-[4px] px-[5px] py-[3px] font-condensed text-xs leading-none font-semibold tracking-[0.02em] tabular-nums",
                  amber ? "bg-warning-surface text-warning-ink" : "bg-muted text-foreground",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** "● Synced from Calendly 4 min ago · 36 returned · 1 not returned · …" with Sync now. */
export function SyncLine({
  syncedAgo,
  returned,
  notReturned,
  switchedOff,
  unsorted,
  syncing,
  onSync,
}: {
  syncedAgo: string | null;
  returned: number;
  notReturned: number;
  switchedOff: number;
  unsorted: number;
  syncing: boolean;
  onSync: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-b border-border bg-background px-4 py-[7px] text-[12.5px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", syncedAgo ? "bg-primary" : "bg-stage-held")} />
        {syncedAgo ? (
          <span>
            Synced from Calendly <b className="font-semibold text-foreground">{syncedAgo}</b>
          </span>
        ) : (
          "Not synced from Calendly yet"
        )}
      </span>
      <span>{returned} returned</span>
      <span className={cn(notReturned > 0 && "text-warning-ink")}>{notReturned} not returned</span>
      <span>{switchedOff} switched off in Calendly</span>
      <span>{unsorted} unsorted</span>
      <Button variant="outline" size="sm" className="ml-auto h-7 gap-1.5 bg-card px-2.5 text-[13px]" onClick={onSync} disabled={syncing}>
        <RefreshCwIcon className={cn("size-3.5", syncing && "animate-spin")} aria-hidden="true" />
        {syncing ? "Syncing…" : "Sync now"}
      </Button>
    </div>
  );
}

const UNSORTED = "__unsorted";
const NOT_SALES = "__not_sales";

/** COUNTS FOR: an inline select that sorts the event type when changed. */
export function CountsForSelect({
  row,
  programs,
  onChange,
  label,
}: {
  row: EventTypeRow;
  programs: readonly CoverageProgram[];
  onChange: (value: { kind: "program"; programId: string } | { kind: "unsorted" } | { kind: "not_sales_call" }) => void;
  label: string;
}) {
  const value =
    row.status === "not_sales_call" ? NOT_SALES : row.status === "sorted" && row.eventType.bookingProgramId ? row.eventType.bookingProgramId : UNSORTED;
  const archived = row.status === "sorted" && !programs.some((program) => program._id === row.eventType.bookingProgramId);
  return (
    <div className="relative min-w-0">
      <select
        aria-label={label}
        value={value}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const next = event.target.value;
          if (next === UNSORTED) onChange({ kind: "unsorted" });
          else if (next === NOT_SALES) onChange({ kind: "not_sales_call" });
          else onChange({ kind: "program", programId: next });
        }}
        className={cn(
          "h-7 w-full min-w-0 cursor-pointer appearance-none truncate rounded-[5.6px] border border-transparent bg-transparent pr-5 pl-1.5 text-[13px] outline-none hover:border-input hover:bg-card focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          value === UNSORTED && "font-medium text-warning-ink",
          value === NOT_SALES && "text-stage-held",
        )}
      >
        <option value={UNSORTED}>Unsorted</option>
        {archived ? <option value={row.eventType.bookingProgramId}>{row.programName ?? "A removed program"}</option> : null}
        {programs.map((program) => (
          <option key={program._id} value={program._id}>
            {program.name}
          </option>
        ))}
        <option value={NOT_SALES}>Not a sales call</option>
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-1.5 size-2.5 -translate-y-1/2 text-stage-held" aria-hidden="true" />
    </div>
  );
}

/** SCHEDULING: the Priority/Standard word; on a filed event type it toggles the mode. */
export function SchedulingWord({ row, onToggle }: { row: EventTypeRow; onToggle: () => void }) {
  const mode = modeOf(row.eventType);
  if (row.status !== "sorted") {
    return <span className={cn(WORD, "text-stage-held")}>{modeLabel(mode)}</span>;
  }
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      title={`Switch to ${modeLabel(mode === "normal" ? "extended" : "normal")}`}
      aria-label={`Scheduling: ${modeLabel(mode)}. Switch to ${modeLabel(mode === "normal" ? "extended" : "normal")}`}
      className={cn(WORD, "-mx-1.5 rounded-[5px] px-1.5 py-1.5 text-stage-held outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50")}
    >
      {modeLabel(mode)}
    </button>
  );
}

/** The EVENT TYPE cell: dot, name, and the line under it. */
export function EventTypeName({ row }: { row: EventTypeRow }) {
  return (
    <div className="flex min-w-0 flex-col py-[5px]">
      <span className="flex min-w-0 items-center gap-1.5">
        <CalendlyDot color={row.eventType.calendlyColor} />
        <span className="truncate text-[13.5px] font-medium">{row.eventType.displayName}</span>
      </span>
      <span className={cn("truncate pl-3.5 text-xs", row.sub.warn ? "text-warning-ink" : "text-muted-foreground")}>
        {row.sub.warn ? <TriangleAlertIcon className="mr-1 inline size-[11px] -translate-y-px" aria-hidden="true" /> : null}
        {row.sub.text}
      </span>
    </div>
  );
}
