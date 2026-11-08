"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { CARD, CardHead, HelpTip, Initials, LABEL } from "@/app/workspace/team/_components/team-ui";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { cn } from "@/lib/utils";
import {
  CardFooter,
  INK_CHECKBOX,
  ROW_FIGURE,
  SELECT_ROW,
  STATUS_WORD,
  formatHours,
  reasonLabel,
  type CandidateCloser,
} from "./redistribute-ui";

// Step 2: the other closers that day, one 44px row each: AVAILABLE in ink,
// OFF in slate (off all day, so they can't be picked), their calls that day as
// a plain figure. Part-day time off is a slate note beside the name.

/** CHECKBOX · CLOSER · CALLS · STATUS; under @3xl/closers the calls go under the name. */
const COLUMNS =
  "grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 @3xl/closers:grid-cols-[1rem_minmax(0,1fr)_7rem_6.5rem] @3xl/closers:gap-x-4";

export function DistributeStep({
  closers,
  selectedIds,
  callCount,
  onToggle,
  onToggleAll,
  onBack,
  onMove,
  isDistributing,
}: {
  closers: CandidateCloser[] | undefined;
  selectedIds: Set<Id<"users">>;
  /** How many calls were picked on the Review step. */
  callCount: number;
  onToggle: (id: Id<"users">) => void;
  onToggleAll: () => void;
  onBack: () => void;
  /** Opens the confirmation. */
  onMove: () => void;
  isDistributing: boolean;
}) {
  const available = (closers ?? []).filter((closer) => closer.isAvailable);
  const allSelected = available.length > 0 && selectedIds.size === available.length;

  return (
    <section aria-labelledby="distribute-title" className={cn(CARD, "@container/closers")}>
      <CardHead
        title={<span id="distribute-title">Choose closers</span>}
        meta={
          <HelpTip tip="Each call, earliest first, goes to a chosen closer who is free then (not off, no call within 15 minutes), favouring fewer calls that day. Any call nobody can take comes back to you to assign or cancel.">
            Who gets which call
          </HelpTip>
        }
      >
        {available.length > 1 ? (
          <label className="flex min-h-6 cursor-pointer items-center gap-2 rounded-sm px-1 text-[13px] font-medium">
            <Checkbox
              checked={allSelected}
              onCheckedChange={onToggleAll}
              aria-label="Select all available closers"
              className={INK_CHECKBOX}
            />
            Select all
          </label>
        ) : null}
      </CardHead>

      {closers === undefined ? (
        <CloserRowsSkeleton />
      ) : closers.length === 0 ? (
        <SectionEmpty title="No other closers to take these calls.">Invite a closer from Team first.</SectionEmpty>
      ) : (
        <>
          <div className={cn(COLUMNS, "hidden min-h-7 border-b border-border px-4 pt-2 pb-1.5 @3xl/closers:grid", LABEL)}>
            <span />
            <span>Closer</span>
            <span className="text-right">Calls that day</span>
            <span>Status</span>
          </div>
          <ul aria-label="Closers">
            {closers.map((closer) => (
              <CloserRow
                key={closer.closerId}
                closer={closer}
                checked={selectedIds.has(closer.closerId)}
                onToggle={() => onToggle(closer.closerId)}
              />
            ))}
          </ul>
        </>
      )}

      <CardFooter
        aside={closers !== undefined && closers.length > 0 && available.length === 0 ? "Every other closer is off that day." : undefined}
      >
        <Button variant="outline" onClick={onBack} disabled={isDistributing}>
          Back
        </Button>
        <Button
          onClick={onMove}
          disabled={selectedIds.size === 0 || isDistributing || available.length === 0}
          className="font-semibold"
        >
          Move {callCount} {callCount === 1 ? "call" : "calls"}…
        </Button>
      </CardFooter>
    </section>
  );
}

function CloserRow({ closer, checked, onToggle }: { closer: CandidateCloser; checked: boolean; onToggle: () => void }) {
  const off = !closer.isAvailable;
  // Off all day: the reason. Off part of the day: the hours.
  const note = off
    ? reasonLabel(closer.unavailabilityReason)
    : closer.blockedRanges
        .filter((range) => !range.isFullDay)
        .map((range) => `Off ${formatHours(range.rangeStart, range.rangeEnd)}`)
        .join(", ") || null;
  const calls = closer.meetingsToday;

  return (
    <li>
      <label className={cn(COLUMNS, SELECT_ROW, "@3xl/closers:min-h-11 @3xl/closers:py-1.5")}>
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          disabled={off}
          aria-label={`Select ${closer.closerName}`}
          className={INK_CHECKBOX}
        />
        <span className="flex min-w-0 items-center gap-2.5">
          <Initials name={closer.closerName} />
          <span className="min-w-0">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cn("truncate leading-5 font-medium", off && "text-muted-foreground")} translate="no">
                {closer.closerName}
              </span>
              {note ? (
                <span className="hidden shrink-0 text-[13px] text-muted-foreground @3xl/closers:inline">{note}</span>
              ) : null}
            </span>
            <span className="block truncate text-[13px] leading-[18px] text-muted-foreground @3xl/closers:hidden">
              <span className="font-condensed text-[14px] font-semibold tabular-nums">{calls}</span>{" "}
              {calls === 1 ? "call" : "calls"} that day{note ? ` · ${note}` : ""}
            </span>
          </span>
        </span>
        <span
          className={cn(
            ROW_FIGURE,
            "hidden text-right @3xl/closers:block",
            (off || calls === 0) && "text-muted-foreground",
          )}
        >
          {calls}
        </span>
        <span className={cn(STATUS_WORD, off ? "text-muted-foreground" : "text-foreground")}>
          {off ? "Off" : "Available"}
        </span>
      </label>
    </li>
  );
}

function CloserRowsSkeleton() {
  return (
    <div role="status" aria-label="Loading closers">
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          className="flex min-h-[52px] items-center gap-3 border-b border-border px-4 py-2 last:border-b-0 @3xl/closers:min-h-11 @3xl/closers:py-1.5"
        >
          <Skeleton className="size-4 rounded-[4px]" />
          <Skeleton className="size-7 rounded-full" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="ml-auto h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}
