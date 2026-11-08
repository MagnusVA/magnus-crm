"use client";

import { useEffect, useMemo, useRef } from "react";
import { useMutation } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import posthog from "@/lib/posthog-browser";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { withSorting, type CoverageEventType, type EventTypeSorting, type SchedulingMode } from "../booking-model";
import type { CellRef } from "./coverage-model";

type CellArgs = {
  teamId: Id<"attributionTeams"> | null;
  programId: Id<"tenantPrograms">;
  mode: SchedulingMode;
  eventTypeConfigId: Id<"eventTypeConfigs"> | null;
  restore?: boolean;
};

function cellArgs(ref: CellRef, eventTypeConfigId: string | null, restore?: boolean): CellArgs {
  return {
    teamId: ref.teamId as Id<"attributionTeams"> | null,
    programId: ref.programId as Id<"tenantPrograms">,
    mode: ref.mode,
    eventTypeConfigId: eventTypeConfigId as Id<"eventTypeConfigs"> | null,
    ...(restore ? { restore: true } : {}),
  };
}

// The coverage snapshot as setCell will leave it, so the cell flips at once.
function setCellOptimistically(store: OptimisticLocalStore, args: CellArgs) {
  const coverage = store.getQuery(api.bookingSetup.queries.getCoverage, {});
  if (!coverage) return;
  const sameCell = (route: { programId: string; mode: SchedulingMode }) =>
    route.programId === args.programId && route.mode === args.mode;
  if (args.teamId === null) {
    const rest = coverage.sharedRoutes.filter((route) => !sameCell(route));
    store.setQuery(api.bookingSetup.queries.getCoverage, {}, {
      ...coverage,
      sharedRoutes: args.eventTypeConfigId
        ? [
            ...rest,
            {
              _id: `optimistic:${args.programId}:${args.mode}` as Id<"sharedProgramEventTypes">,
              programId: args.programId,
              mode: args.mode,
              eventTypeConfigId: args.eventTypeConfigId,
            },
          ]
        : rest,
    });
    return;
  }
  const teamId = args.teamId;
  const rest = coverage.teamRoutes.filter((route) => !(route.teamId === teamId && sameCell(route)));
  store.setQuery(api.bookingSetup.queries.getCoverage, {}, {
    ...coverage,
    teamRoutes: args.eventTypeConfigId
      ? [
          ...rest,
          {
            _id: `optimistic:${teamId}:${args.programId}:${args.mode}` as Id<"teamProgramEventTypes">,
            teamId,
            programId: args.programId,
            mode: args.mode,
            eventTypeConfigId: args.eventTypeConfigId,
          },
        ]
      : rest,
  });
}

function sortOptimistically(
  store: OptimisticLocalStore,
  args: { eventTypeConfigId: Id<"eventTypeConfigs">; sorting: EventTypeSorting },
) {
  const coverage = store.getQuery(api.bookingSetup.queries.getCoverage, {});
  if (!coverage) return;
  const now = Date.now();
  store.setQuery(api.bookingSetup.queries.getCoverage, {}, {
    ...coverage,
    eventTypes: coverage.eventTypes.map((eventType) =>
      eventType._id === args.eventTypeConfigId ? withSorting(eventType, args.sorting, now) : eventType,
    ),
  });
}

function setUrlOptimistically(
  store: OptimisticLocalStore,
  args: { eventTypeConfigId: Id<"eventTypeConfigs">; bookingBaseUrl: string | null },
) {
  const coverage = store.getQuery(api.bookingSetup.queries.getCoverage, {});
  if (!coverage) return;
  const url = args.bookingBaseUrl?.trim() || undefined;
  store.setQuery(api.bookingSetup.queries.getCoverage, {}, {
    ...coverage,
    eventTypes: coverage.eventTypes.map((eventType) =>
      eventType._id === args.eventTypeConfigId
        ? { ...eventType, bookingBaseUrl: url, bookingUrlSource: url ? ("admin_entered" as const) : undefined }
        : eventType,
    ),
  });
}

function setUsesSharedOptimistically(
  store: OptimisticLocalStore,
  args: { teamId: Id<"attributionTeams">; usesShared: boolean },
) {
  const coverage = store.getQuery(api.bookingSetup.queries.getCoverage, {});
  if (!coverage) return;
  store.setQuery(api.bookingSetup.queries.getCoverage, {}, {
    ...coverage,
    teams: coverage.teams.map((team) => (team._id === args.teamId ? { ...team, usesShared: args.usesShared } : team)),
  });
}

function undoFailed(flow: string) {
  return (error: unknown) => {
    reportClientError(error, { flow });
    toast.error(getErrorMessage(error, "Couldn't undo that change."));
  };
}

/**
 * Every write the Coverage tab makes. Each goes live at once (optimistic),
 * then toasts with an Undo that puts back exactly what it changed.
 * `onCellChanged` hears about every cell written, for the preview's hint.
 */
export function useCoverageActions(onCellChanged?: (ref: CellRef) => void) {
  const setCell = useMutation(api.bookingSetup.mutations.setCell).withOptimisticUpdate(setCellOptimistically);
  const sortEventType = useMutation(api.bookingSetup.mutations.sortEventType).withOptimisticUpdate(sortOptimistically);
  const setBookingUrl = useMutation(api.bookingSetup.mutations.setEventTypeBookingUrl).withOptimisticUpdate(setUrlOptimistically);
  const setTeamUsesShared = useMutation(api.bookingSetup.mutations.setTeamUsesShared).withOptimisticUpdate(
    setUsesSharedOptimistically,
  );

  /** Puts an event type in a cell (or clears it with null). Resolves true on success. */
  async function assign(ref: CellRef, eventTypeConfigId: string | null, message: string, where: string) {
    try {
      const { previousEventTypeConfigId } = await setCell(cellArgs(ref, eventTypeConfigId));
      posthog.capture("booking_cell_set", { shared: ref.teamId === null, cleared: eventTypeConfigId === null, source: "coverage" });
      onCellChanged?.(ref);
      toast.success(message, {
        description: where,
        action: {
          label: "Undo",
          onClick: () => {
            setCell(cellArgs(ref, previousEventTypeConfigId, true))
              .then(() => onCellChanged?.(ref))
              .catch(undoFailed("booking_cell_undo"));
          },
        },
      });
      return true;
    } catch (error) {
      reportClientError(error, { flow: "booking_cell_set" });
      toast.error(getErrorMessage(error, "Couldn't change this cell."));
      return false;
    }
  }

  /**
   * Sorts the event type into the cell's program and mode, then puts it in
   * the cell. A failed cell write rolls the sort back; Undo reverts both.
   */
  async function sortAndAssign(ref: CellRef, eventType: CoverageEventType, message: string, where: string) {
    const eventTypeConfigId = eventType._id as Id<"eventTypeConfigs">;
    let previousSorting: EventTypeSorting;
    try {
      previousSorting = await sortEventType({
        eventTypeConfigId,
        sorting: { kind: "program", programId: ref.programId as Id<"tenantPrograms">, mode: ref.mode },
      });
    } catch (error) {
      reportClientError(error, { flow: "booking_cell_sort_and_use" });
      toast.error(getErrorMessage(error, "Couldn't sort this event type."));
      return false;
    }
    let previousEventTypeConfigId: Id<"eventTypeConfigs"> | null;
    try {
      ({ previousEventTypeConfigId } = await setCell(cellArgs(ref, eventTypeConfigId)));
    } catch (error) {
      reportClientError(error, { flow: "booking_cell_sort_and_use" });
      toast.error(getErrorMessage(error, "Couldn't change this cell. The event type was put back where it was."));
      await sortEventType({ eventTypeConfigId, sorting: previousSorting }).catch((rollbackError: unknown) => {
        reportClientError(rollbackError, { flow: "booking_cell_sort_rollback" });
      });
      return false;
    }
    posthog.capture("booking_cell_set", { shared: ref.teamId === null, cleared: false, sorted: true, source: "coverage" });
    onCellChanged?.(ref);
    toast.success(message, {
      description: where,
      action: {
        label: "Undo",
        onClick: () => {
          void (async () => {
            await setCell(cellArgs(ref, previousEventTypeConfigId, true));
            await sortEventType({ eventTypeConfigId, sorting: previousSorting });
            onCellChanged?.(ref);
          })().catch(undoFailed("booking_cell_undo"));
        },
      },
    });
    return true;
  }

  /** Sorts an event type into a program without placing it anywhere. */
  async function sortOnly(eventType: CoverageEventType, sorting: EventTypeSorting, message: string) {
    const eventTypeConfigId = eventType._id as Id<"eventTypeConfigs">;
    try {
      const previous = await sortEventType({ eventTypeConfigId, sorting });
      posthog.capture("booking_event_type_sorted", { source: "coverage_picker", to: sorting.kind, count: 1, failed: 0 });
      toast.success(message, {
        action: {
          label: "Undo",
          onClick: () => {
            sortEventType({ eventTypeConfigId, sorting: previous }).catch(undoFailed("booking_sort_undo"));
          },
        },
      });
      return true;
    } catch (error) {
      reportClientError(error, { flow: "booking_sort_event_type" });
      toast.error(getErrorMessage(error, "Couldn't sort this event type."));
      return false;
    }
  }

  /**
   * Sets the event type's booking URL, then puts it in the cell. Undo puts
   * the cell back, and clears the URL again when it had none before.
   */
  async function setUrlAndAssign(ref: CellRef, eventType: CoverageEventType, url: string, message: string, where: string) {
    const eventTypeConfigId = eventType._id as Id<"eventTypeConfigs">;
    const hadUrl = Boolean(eventType.bookingBaseUrl);
    try {
      await setBookingUrl({ eventTypeConfigId, bookingBaseUrl: url });
    } catch (error) {
      reportClientError(error, { flow: "booking_set_url" });
      toast.error(getErrorMessage(error, "Couldn't save that booking URL."));
      return false;
    }
    let previousEventTypeConfigId: Id<"eventTypeConfigs"> | null;
    try {
      ({ previousEventTypeConfigId } = await setCell(cellArgs(ref, eventTypeConfigId)));
    } catch (error) {
      reportClientError(error, { flow: "booking_set_url_and_use" });
      toast.error(getErrorMessage(error, "The booking URL is saved, but the cell didn't change."));
      return false;
    }
    posthog.capture("booking_cell_set", { shared: ref.teamId === null, cleared: false, urlSet: true, source: "coverage" });
    onCellChanged?.(ref);
    toast.success(message, {
      description: where,
      action: {
        label: "Undo",
        onClick: () => {
          void (async () => {
            await setCell(cellArgs(ref, previousEventTypeConfigId, true));
            if (!hadUrl) await setBookingUrl({ eventTypeConfigId, bookingBaseUrl: null });
            onCellChanged?.(ref);
          })().catch(undoFailed("booking_cell_undo"));
        },
      },
    });
    return true;
  }

  async function setUsesShared(team: { _id: string; displayName: string }, usesShared: boolean) {
    const teamId = team._id as Id<"attributionTeams">;
    try {
      await setTeamUsesShared({ teamId, usesShared });
      posthog.capture("booking_team_uses_shared_set", { usesShared });
      toast.success(
        usesShared ? `${team.displayName}’s empty cells use Shared` : `${team.displayName} uses its own routes only`,
        {
          action: {
            label: "Undo",
            onClick: () => {
              setTeamUsesShared({ teamId, usesShared: !usesShared }).catch(undoFailed("booking_team_uses_shared_undo"));
            },
          },
        },
      );
    } catch (error) {
      reportClientError(error, { flow: "booking_team_uses_shared_set" });
      toast.error(getErrorMessage(error, "Couldn't change this team."));
    }
  }

  // The writes close over this render's mutations. Hand out stable wrappers
  // that call the latest ones, so readers of the actions don't re-render.
  const latest = useRef({ assign, sortAndAssign, sortOnly, setUrlAndAssign, setUsesShared });
  useEffect(() => {
    latest.current = { assign, sortAndAssign, sortOnly, setUrlAndAssign, setUsesShared };
  });
  return useMemo(
    () => ({
      assign: (...args: Parameters<typeof assign>) => latest.current.assign(...args),
      sortAndAssign: (...args: Parameters<typeof sortAndAssign>) => latest.current.sortAndAssign(...args),
      sortOnly: (...args: Parameters<typeof sortOnly>) => latest.current.sortOnly(...args),
      setUrlAndAssign: (...args: Parameters<typeof setUrlAndAssign>) => latest.current.setUrlAndAssign(...args),
      setUsesShared: (...args: Parameters<typeof setUsesShared>) => latest.current.setUsesShared(...args),
    }),
    [],
  );
}

export type CoverageActions = ReturnType<typeof useCoverageActions>;
