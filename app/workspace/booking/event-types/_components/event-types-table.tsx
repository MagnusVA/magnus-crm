"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { modeOf, type CoverageProgram } from "../../_components/booking-model";
import type { EventTypeRow } from "../../_components/event-types/event-type-rows";
import {
  COL_BOOKABLE,
  COL_PORTAL,
  COL_SCHEDULING,
  CountsForSelect,
  EventTypeName,
  LABEL,
  ROW_GRID,
  SchedulingWord,
  TONE,
  WORD,
} from "./event-types-parts";

export type SortTarget = { kind: "program"; programId: string; mode: "normal" | "extended" } | { kind: "unsorted" } | { kind: "not_sales_call" };

const CHECKBOX = "size-4 cursor-pointer accent-foreground";

/** The Event types table: one row per event type, most-booked first, with checkboxes for bulk sorting. */
export function EventTypesTable({
  rows,
  programs,
  selected,
  onSelect,
  onSelectAll,
  onOpen,
  onSort,
  emptyText,
}: {
  rows: EventTypeRow[];
  programs: readonly CoverageProgram[];
  selected: ReadonlySet<string>;
  onSelect: (id: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  onOpen: (id: string) => void;
  onSort: (row: EventTypeRow, target: SortTarget) => void;
  emptyText: string;
}) {
  const allChecked = rows.length > 0 && rows.every((row) => selected.has(row.eventType._id));
  return (
    <>
      <div role="table" aria-label="Event types" aria-rowcount={rows.length + 1}>
        <div role="row" className={cn(ROW_GRID, "sticky top-0 z-[2] min-h-[30px] border-b border-border bg-card")}>
          <span role="columnheader" className="flex items-center">
            <input
              type="checkbox"
              className={CHECKBOX}
              aria-label="Select all shown"
              checked={allChecked}
              disabled={rows.length === 0}
              onChange={(event) => onSelectAll(event.target.checked)}
            />
          </span>
          <span role="columnheader" className={LABEL}>
            Event type
          </span>
          <span role="columnheader" className={cn(LABEL, "pl-1.5")}>
            Counts for
          </span>
          <span role="columnheader" className={cn(LABEL, COL_SCHEDULING)}>
            Scheduling
          </span>
          <span role="columnheader" className={cn(LABEL, COL_BOOKABLE)}>
            Bookable
          </span>
          <span role="columnheader" className={cn(LABEL, COL_PORTAL)}>
            In portal
          </span>
          <span role="columnheader" className={cn(LABEL, "text-right")}>
            30 days
          </span>
        </div>
        {rows.map((row) => (
          <Row
            key={row.eventType._id}
            row={row}
            programs={programs}
            checked={selected.has(row.eventType._id)}
            onSelect={onSelect}
            onOpen={onOpen}
            onSort={onSort}
          />
        ))}
      </div>
      {/* Outside the table: a table may hold only rows. */}
      {rows.length === 0 ? <p className="px-4 py-7 text-[13.5px] text-muted-foreground">{emptyText}</p> : null}
    </>
  );
}

function Row({
  row,
  programs,
  checked,
  onSelect,
  onOpen,
  onSort,
}: {
  row: EventTypeRow;
  programs: readonly CoverageProgram[];
  checked: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onOpen: (id: string) => void;
  onSort: (row: EventTypeRow, target: SortTarget) => void;
}) {
  const id = row.eventType._id;
  const [leaving, setLeaving] = useState(false);
  return (
    <div
      role="row"
      data-row={id}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("select, input, button, a")) return;
        onOpen(id);
      }}
      className={cn(
        ROW_GRID,
        "min-h-10 cursor-pointer border-b border-border transition-colors hover:bg-muted/40",
        checked && "bg-stage-booked/6 hover:bg-stage-booked/10",
        leaving && "opacity-60",
      )}
    >
      <span role="cell" className="flex items-center">
        <input
          type="checkbox"
          className={CHECKBOX}
          aria-label={`Select ${row.eventType.displayName}`}
          checked={checked}
          onChange={(event) => onSelect(id, event.target.checked)}
        />
      </span>
      <span role="cell" className="min-w-0">
        <button
          type="button"
          onClick={() => onOpen(id)}
          className="block w-full min-w-0 rounded-[5px] text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label={`Open ${row.eventType.displayName}`}
        >
          <EventTypeName row={row} />
        </button>
      </span>
      <span role="cell" className="min-w-0">
        <CountsForSelect
          row={row}
          programs={programs}
          label={`Counts for: ${row.eventType.displayName}`}
          onChange={(value) => {
            setLeaving(true);
            window.setTimeout(() => setLeaving(false), 400);
            onSort(row, value.kind === "program" ? { kind: "program", programId: value.programId, mode: modeOf(row.eventType) } : value);
          }}
        />
      </span>
      <span role="cell" className={COL_SCHEDULING}>
        <SchedulingWord
          row={row}
          onToggle={() =>
            row.eventType.bookingProgramId &&
            onSort(row, {
              kind: "program",
              programId: row.eventType.bookingProgramId,
              mode: modeOf(row.eventType) === "normal" ? "extended" : "normal",
            })
          }
        />
      </span>
      <span role="cell" className={cn(WORD, COL_BOOKABLE, TONE[row.bookable.tone])}>
        {row.bookable.word}
      </span>
      <span
        role="cell"
        className={cn(COL_PORTAL, "truncate", row.portal.condensed ? cn(WORD, TONE[row.portal.tone]) : cn("text-[13px]", TONE[row.portal.tone]))}
      >
        {row.portal.word}
      </span>
      <span
        role="cell"
        className={cn("text-right font-condensed text-[15px] leading-none font-semibold tabular-nums", row.bookings === 0 && "text-stage-held")}
      >
        {row.bookings}
      </span>
    </div>
  );
}

/** The navy bar that appears when rows are checked: file them all at once, with one Undo. */
export function BulkBar({
  count,
  programs,
  onNotSalesCall,
  onProgram,
  onClear,
}: {
  count: number;
  programs: readonly CoverageProgram[];
  onNotSalesCall: () => void;
  onProgram: (programId: string) => void;
  onClear: () => void;
}) {
  return (
    <div
      role="region"
      aria-label={`${count} selected`}
      className="sticky bottom-2.5 z-[3] m-2.5 flex flex-wrap items-center gap-2.5 rounded-[9.8px] bg-board px-3.5 py-[9px] text-board-foreground animate-in fade-in-0 slide-in-from-bottom-2"
    >
      <b className="mr-1.5 font-condensed text-[15px] font-semibold tracking-[0.04em]">{count} selected</b>
      <button
        type="button"
        onClick={onNotSalesCall}
        className="inline-flex h-8 items-center rounded-[7px] border border-white/15 bg-board-raised px-3 text-[13px] font-medium outline-none hover:bg-white/10 focus-visible:ring-3 focus-visible:ring-primary/50"
      >
        Not a sales call
      </button>
      <label className="relative">
        <span className="sr-only">Counts for</span>
        <select
          value=""
          onChange={(event) => {
            if (event.target.value) onProgram(event.target.value);
          }}
          className="h-8 w-[min(320px,60vw)] cursor-pointer appearance-none rounded-[7px] border border-white/15 bg-board-raised pr-7 pl-2.5 text-[13px] text-board-foreground outline-none focus-visible:ring-3 focus-visible:ring-primary/50"
        >
          <option value="">Counts for…</option>
          {programs.map((program) => (
            <option key={program._id} value={program._id}>
              {program.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto inline-flex h-8 items-center rounded-[7px] border border-white/15 bg-board-raised px-3 text-[13px] font-medium outline-none hover:bg-white/10 focus-visible:ring-3 focus-visible:ring-primary/50"
      >
        Clear
      </button>
    </div>
  );
}
