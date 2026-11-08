"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CARD, CardHead, LABEL } from "@/app/workspace/team/_components/team-ui";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { cn } from "@/lib/utils";
import {
  CardFooter,
  INK_CHECKBOX,
  ROW_FIGURE,
  SELECT_ROW,
  STATUS_WORD,
  formatTime,
  type AffectedCall,
} from "./redistribute-ui";

// Step 1: the closer's calls in the record's hours, one 44px row each. Calls
// still theirs are TO MOVE (owed, amber); ones already moved under this
// record are MOVED (done, slate) and can't be picked again.

/** CHECKBOX · TIME · LENGTH · LEAD · STATUS; under @3xl/calls the lead over time · length. */
const COLUMNS =
  "grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 @3xl/calls:grid-cols-[1rem_5.5rem_4.5rem_minmax(0,1fr)_6rem] @3xl/calls:gap-x-4";

export function ReviewStep({
  calls,
  pendingCount,
  selectedIds,
  onToggle,
  onToggleAll,
  onNext,
  onBackToTeam,
  day,
  partial,
}: {
  /** Every affected call, earliest first. */
  calls: AffectedCall[];
  pendingCount: number;
  selectedIds: Set<Id<"meetings">>;
  onToggle: (id: Id<"meetings">) => void;
  onToggleAll: () => void;
  onNext: () => void;
  onBackToTeam: () => void;
  /** "Thursday, Nov 5", for the empty line. */
  day: string;
  /** The record covers part of the day, so the list holds only those hours. */
  partial: boolean;
}) {
  const movedCount = calls.length - pendingCount;
  const allSelected = pendingCount > 0 && selectedIds.size === pendingCount;
  const meta =
    calls.length === 0
      ? undefined
      : [pendingCount > 0 ? `${pendingCount} to move` : null, movedCount > 0 ? `${movedCount} moved` : null]
          .filter(Boolean)
          .join(" · ");

  return (
    <section aria-labelledby="review-title" className={cn(CARD, "@container/calls")}>
      <CardHead title={<span id="review-title">{partial ? "Calls in those hours" : "Calls that day"}</span>} meta={meta}>
        {pendingCount > 0 ? (
          <label className="flex min-h-6 cursor-pointer items-center gap-2 rounded-sm px-1 text-[13px] font-medium">
            <Checkbox
              checked={allSelected}
              onCheckedChange={onToggleAll}
              aria-label="Select all calls to move"
              className={INK_CHECKBOX}
            />
            Select all
          </label>
        ) : null}
      </CardHead>

      {calls.length === 0 ? (
        <SectionEmpty title={`No calls to move on ${day}.`}>
          They have no scheduled calls {partial ? "in those hours" : "that day"}.
        </SectionEmpty>
      ) : (
        <>
          <div className={cn(COLUMNS, "hidden min-h-7 border-b border-border px-4 pt-2 pb-1.5 @3xl/calls:grid", LABEL)}>
            <span />
            <span>Time</span>
            <span>Length</span>
            <span>Lead</span>
            <span>Status</span>
          </div>
          <ul aria-label="Calls">
            {calls.map((call) => (
              <CallRow
                key={call.meetingId}
                call={call}
                checked={selectedIds.has(call.meetingId)}
                onToggle={() => onToggle(call.meetingId)}
              />
            ))}
          </ul>
        </>
      )}

      <CardFooter aside={pendingCount === 0 && calls.length > 0 ? "Every call is already moved." : undefined}>
        {pendingCount === 0 ? (
          <Button onClick={onBackToTeam} className="font-semibold">
            Back to Team
          </Button>
        ) : (
          <Button onClick={onNext} disabled={selectedIds.size === 0} className="font-semibold">
            Choose closers ({selectedIds.size})
          </Button>
        )}
      </CardFooter>
    </section>
  );
}

function CallRow({ call, checked, onToggle }: { call: AffectedCall; checked: boolean; onToggle: () => void }) {
  const lead = call.leadName ?? "Unknown lead";
  const moved = call.alreadyReassigned;
  const time = formatTime(call.scheduledAt);
  const length = `${call.durationMinutes} min`;
  return (
    <li>
      <label className={cn(COLUMNS, SELECT_ROW, "@3xl/calls:min-h-11 @3xl/calls:py-1.5")}>
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          disabled={moved}
          aria-label={`Select ${lead}`}
          className={INK_CHECKBOX}
        />
        <span className={cn(ROW_FIGURE, "hidden whitespace-nowrap @3xl/calls:block", moved && "text-muted-foreground")}>
          {time}
        </span>
        <span className="hidden font-condensed text-[14px] font-semibold whitespace-nowrap text-muted-foreground tabular-nums @3xl/calls:block">
          {length}
        </span>
        <span className="min-w-0">
          <span className={cn("block truncate leading-5 font-medium", moved && "text-muted-foreground")} translate="no">
            {lead}
          </span>
          <span className="block truncate text-[13px] leading-[18px] text-muted-foreground @3xl/calls:hidden">
            <span className="font-condensed text-[14px] font-semibold tabular-nums">{time}</span> · {length}
          </span>
        </span>
        <span className={cn(STATUS_WORD, moved ? "text-muted-foreground" : "text-warning-ink")}>
          {moved ? "Moved" : "To move"}
        </span>
      </label>
    </li>
  );
}
