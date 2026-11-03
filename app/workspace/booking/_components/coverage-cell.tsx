"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import posthog from "posthog-js";
import { CornerDownRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CELL_ISSUE_LABEL, SCHEDULING_MODE_LABEL } from "@/convex/lib/bookingSetup/coverage";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import {
  eventTypeFacts,
  eventTypeStatus,
  linkIssue,
  modeOf,
  type Board,
  type CoverageProgram,
  type CoverageTeam,
  type ResolvedCell,
  type SchedulingMode,
} from "./booking-model";

type Placement = {
  program: CoverageProgram;
  mode: SchedulingMode;
  // null: the Shared column.
  team: CoverageTeam | null;
};

/**
 * One slot of the coverage board: the event type a team's Priority or
 * Standard link books for a program. The button says what the slot resolves
 * to in words; it opens a picker that changes it live, with Undo.
 */
export function CoverageCell({
  board,
  placement,
  resolved,
  disabled,
}: {
  board: Board;
  placement: Placement;
  resolved: ResolvedCell;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { program, mode, team } = placement;
  const where = `${program.name} · ${SCHEDULING_MODE_LABEL[mode]} · ${team?.displayName ?? "Shared"}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={`${where}: ${describeCell(board, resolved, team)}`}
        className={cn(
          "group/cell flex h-full min-h-11 w-full min-w-0 flex-col justify-center gap-0.5 px-3 py-1.5 text-left outline-none",
          "hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-expanded:bg-muted",
          "disabled:pointer-events-none",
        )}
      >
        <CellFace board={board} resolved={resolved} team={team} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] p-0">
        <CellPicker
          board={board}
          placement={placement}
          resolved={resolved}
          where={where}
          onDone={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function describeCell(board: Board, resolved: ResolvedCell, team: CoverageTeam | null) {
  if (resolved.kind === "none") {
    if (resolved.reason === "not_offered") return "Not offered";
    return team ? "No link: Shared is empty here" : "Empty";
  }
  const name = board.eventTypesById.get(resolved.eventTypeConfigId)?.displayName ?? "Missing event type";
  const prefix = resolved.kind === "inherited" ? "From Shared: " : "";
  return `${prefix}${name}${resolved.issue ? ` (${CELL_ISSUE_LABEL[resolved.issue]})` : ""}`;
}

const WORD = "font-condensed text-[11px] font-bold tracking-[0.1em] uppercase";

function CellFace({
  board,
  resolved,
  team,
}: {
  board: Board;
  resolved: ResolvedCell;
  team: CoverageTeam | null;
}) {
  if (resolved.kind === "none") {
    if (resolved.reason === "not_offered") {
      return <span className="text-[13px] text-muted-foreground/70">Not offered</span>;
    }
    return team ? (
      <span className={cn(WORD, "text-warning-ink")}>No link</span>
    ) : (
      <span className="text-[13px] text-muted-foreground">Empty</span>
    );
  }

  const eventType = board.eventTypesById.get(resolved.eventTypeConfigId);
  const name = eventType?.displayName ?? "Missing event type";
  const inherited = resolved.kind === "inherited";

  return (
    <>
      <span
        className={cn(
          "flex min-w-0 items-center gap-1 text-[13px] leading-tight",
          inherited ? "text-muted-foreground" : "font-medium text-foreground",
          resolved.issue && !inherited && "line-through decoration-danger-ink/60",
        )}
      >
        {inherited ? <CornerDownRightIcon aria-hidden className="size-3 shrink-0" /> : null}
        <span className="truncate">{name}</span>
      </span>
      {resolved.issue ? (
        <span className={cn(WORD, inherited ? "text-warning-ink" : "text-danger-ink")} title={CELL_ISSUE_LABEL[resolved.issue]}>
          {inherited ? "Shared is broken" : "Broken"}
        </span>
      ) : inherited ? (
        <span className={cn(WORD, "text-muted-foreground")}>From Shared</span>
      ) : null}
    </>
  );
}

function CellPicker({
  board,
  placement,
  resolved,
  where,
  onDone,
}: {
  board: Board;
  placement: Placement;
  resolved: ResolvedCell;
  where: string;
  onDone: () => void;
}) {
  const { program, mode, team } = placement;
  const setCell = useMutation(api.bookingSetup.mutations.setCell);
  const sortEventType = useMutation(api.bookingSetup.mutations.sortEventType);
  const [busy, setBusy] = useState(false);

  const ownId = resolved.kind === "own" ? resolved.eventTypeConfigId : null;
  const eventTypes = [...board.eventTypesById.values()];
  const fits = eventTypes
    .filter(
      (eventType) =>
        eventTypeStatus(eventType) === "sorted" &&
        eventType.bookingProgramId === program._id &&
        modeOf(eventType) === mode,
    )
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const unsorted = eventTypes
    .filter((eventType) => eventTypeStatus(eventType) === "unsorted")
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  const cellArgs = { teamId: team?._id ?? null, programId: program._id, mode };

  // Sets the cell; with `sortFirst`, sorts an unsorted event type into this
  // program and mode first. Undo puts back both, and a failed cell write
  // rolls the sort back.
  async function apply(
    eventTypeConfigId: Id<"eventTypeConfigs"> | null,
    message: string,
    sortFirst = false,
  ) {
    setBusy(true);
    let previousSorting: FunctionReturnType<typeof api.bookingSetup.mutations.sortEventType> | null = null;
    try {
      if (sortFirst && eventTypeConfigId) {
        previousSorting = await sortEventType({
          eventTypeConfigId,
          sorting: { kind: "program", programId: program._id, mode },
        });
      }
      const { previousEventTypeConfigId } = await setCell({ ...cellArgs, eventTypeConfigId });
      posthog.capture("booking_cell_set", {
        shared: team === null,
        cleared: eventTypeConfigId === null,
        sorted: previousSorting !== null,
      });
      onDone();
      const undoSorting = previousSorting;
      toast.success(message, {
        description: where,
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              await setCell({ ...cellArgs, eventTypeConfigId: previousEventTypeConfigId, restore: true });
              if (undoSorting && eventTypeConfigId) {
                await sortEventType({ eventTypeConfigId, sorting: undoSorting });
              }
            })().catch((error: unknown) => {
              reportClientError(error, { flow: "booking_cell_undo" });
              toast.error(getErrorMessage(error, "Couldn't undo that change."));
            });
          },
        },
      });
    } catch (error) {
      reportClientError(error, { flow: sortFirst ? "booking_cell_sort_and_use" : "booking_cell_set" });
      toast.error(getErrorMessage(error, "Couldn't change this cell."));
      if (previousSorting && eventTypeConfigId) {
        await sortEventType({ eventTypeConfigId, sorting: previousSorting }).catch((rollbackError: unknown) => {
          reportClientError(rollbackError, { flow: "booking_cell_sort_rollback" });
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Command>
      <div className="border-b border-border px-3 py-2.5">
        <p className="text-[13px] font-semibold">{where}</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {team
            ? team.usesShared
              ? "Pick an event type for this team, or leave it on Shared."
              : "This team doesn't use Shared. Pick an event type or leave it not offered."
            : "Teams that use Shared get this when they have nothing of their own here."}
        </p>
      </div>
      <CommandInput placeholder="Find an event type…" disabled={busy} />
      <CommandList className="max-h-80">
        <CommandEmpty>No event type matches.</CommandEmpty>
        {resolved.kind === "own" ? (
          <CommandGroup>
            <CommandItem
              disabled={busy}
              onSelect={() =>
                apply(null, team ? (team.usesShared ? "Back on Shared" : "No longer offered") : "Shared cell cleared")
              }
            >
              {team ? (team.usesShared ? "Use Shared here" : "Clear (not offered)") : "Clear this cell"}
            </CommandItem>
          </CommandGroup>
        ) : null}
        <CommandGroup heading={`${program.name} · ${SCHEDULING_MODE_LABEL[mode]}`}>
          {fits.length === 0 ? (
            <p className="px-2 py-1.5 text-[13px] text-muted-foreground">
              No {SCHEDULING_MODE_LABEL[mode]} event type counts for {program.name} yet. Sort one in below or from the Inbox.
            </p>
          ) : null}
          {fits.map((eventType) => {
            const issue = linkIssue(eventType);
            return (
              <CommandItem
                key={eventType._id}
                value={`${eventType.displayName} ${eventType._id}`}
                disabled={busy || eventType._id === ownId}
                onSelect={() => apply(eventType._id, `${eventType.displayName} is in this cell`)}
                className="flex items-start justify-between gap-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{eventType.displayName}</span>
                  <span className="block text-[12px] text-muted-foreground">
                    {eventTypeFacts(eventType)}
                  </span>
                </span>
                <span
                  className={cn(
                    WORD,
                    "shrink-0 pt-0.5",
                    eventType._id === ownId ? "text-primary-ink" : issue ? "text-danger-ink" : "text-muted-foreground",
                  )}
                >
                  {eventType._id === ownId ? "In use" : issue === "missing_url" ? "No URL" : issue ? "Inactive" : "Ready"}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
        {unsorted.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Unsorted: sort into this program and use">
              {unsorted.map((eventType) => (
                <CommandItem
                  key={eventType._id}
                  value={`${eventType.displayName} ${eventType._id}`}
                  disabled={busy}
                  onSelect={() =>
                    apply(eventType._id, `${eventType.displayName} now counts for ${program.name} and is in this cell`, true)
                  }
                >
                  <span className="truncate">{eventType.displayName}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </Command>
  );
}
