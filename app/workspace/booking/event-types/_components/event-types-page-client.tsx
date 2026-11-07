"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { formatDistanceToNowStrict } from "date-fns";
import posthog from "@/lib/posthog-browser";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { nameSaysStandard, type LookalikeGroup } from "@/lib/booking-setup/event-type-intel";
import {
  buildBoard,
  modeLabel,
  modeOf,
  type Coverage,
  type EventTypeSorting,
  type SchedulingMode,
} from "../../_components/booking-model";
import {
  buildEventTypeRows,
  parseFilter,
  rowMatchesFilter,
  type EventTypeFilter,
  type EventTypeRow,
} from "../../_components/event-types/event-type-rows";
import type { BookingActivity } from "../../_components/event-types/intel-adapter";
import { useSortEventTypes } from "../../_components/use-sort-event-types";
import { EventTypeSheet } from "./event-type-sheet";
import { EventTypeTools, SyncLine } from "./event-types-parts";
import { EventTypesPageSkeleton } from "./event-types-page-skeleton";
import { BulkBar, EventTypesTable, type SortTarget } from "./event-types-table";
import { LookAlikesView } from "./look-alikes-view";

/**
 * Event types: concept C's library. Every event type Calendly returns, by how
 * it's sorted, with the sync line, inline sorting, bulk actions, look-alike
 * folding and a sheet per event type. The tab and the open event type live in
 * the URL (`?filter=`, `?eventType=`).
 */
export function EventTypesPageClient() {
  usePageTitle("Event types · Booking setup");
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const activity = useQuery(api.bookingSetup.queries.getBookingActivity, {});
  if (coverage === undefined) return <EventTypesPageSkeleton />;
  return <Library coverage={coverage} activity={activity} />;
}

function Library({ coverage, activity }: { coverage: Coverage; activity: BookingActivity | undefined }) {
  const searchParams = useSearchParams();
  const filter = parseFilter(searchParams.get("filter"));
  const openId = searchParams.get("eventType");

  const board = useMemo(() => buildBoard(coverage), [coverage]);
  const { rows, groups, counts } = useMemo(() => buildEventTypeRows(coverage, board, activity), [coverage, board, activity]);
  const programs = board.programs;
  const programName = (id: string) => coverage.programs.find((program) => program._id === id)?.name ?? "A removed program";
  const teamName = (id: string) => coverage.teams.find((team) => team._id === id)?.displayName ?? "A removed team";

  // Full configs for the sheet (payment links, form fields, the editor), only while one is open.
  const configs = useQuery(api.eventTypeConfigs.queries.listEventTypeConfigs, openId ? {} : "skip");

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const { sort } = useSortEventTypes();
  const syncNow = useAction(api.calendly.eventTypes.syncMyTenantEventTypes);

  function writeParams(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const search = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  }

  function setFilter(next: EventTypeFilter) {
    setSelected(new Set());
    writeParams({ filter: next === "sales" ? null : next });
  }

  const needle = query.trim().toLowerCase();
  const shown = rows.filter((row) => rowMatchesFilter(row, filter) && (!needle || row.haystack.includes(needle)));
  const openRow = openId ? (rows.find((row) => row.eventType._id === openId) ?? null) : null;
  const openConfig = openId ? configs?.find((config) => config._id === openId) : undefined;

  // Unsorted event types filed from here take the name's own mode ("Extended" → Standard).
  function modeFor(row: EventTypeRow): SchedulingMode {
    if (row.status === "sorted") return modeOf(row.eventType);
    return nameSaysStandard(row.eventType.displayName) ? "extended" : "normal";
  }

  function sortingFor(target: SortTarget): EventTypeSorting {
    if (target.kind === "program") {
      return { kind: "program", programId: target.programId as Id<"tenantPrograms">, mode: target.mode };
    }
    return target;
  }

  function sortOne(row: EventTypeRow, target: SortTarget, source: "event_types" | "event_type_sheet") {
    const resolved: SortTarget =
      target.kind === "program" && row.status !== "sorted" ? { ...target, mode: modeFor(row) } : target;
    const name = row.eventType.displayName;
    // Coverage cells that point at it and won't match it any more.
    const breaking = row.placements.filter(
      (placement) => resolved.kind !== "program" || placement.programId !== resolved.programId || placement.mode !== resolved.mode,
    ).length;
    const warning =
      breaking > 0 ? ` ${breaking} coverage ${breaking === 1 ? "cell uses" : "cells use"} it and ${breaking === 1 ? "shows" : "show"} as broken until you change ${breaking === 1 ? "it" : "them"}.` : "";
    void sort([{ eventTypeConfigId: row.eventType._id, sorting: sortingFor(resolved) }], {
      message: () =>
        (resolved.kind === "program"
          ? `${name} counts for ${programName(resolved.programId)} · ${modeLabel(resolved.mode)}.`
          : resolved.kind === "not_sales_call"
            ? `${name} marked Not a sales call.`
            : `${name} is back in the inbox.`) + warning,
      analytics: { source, to: resolved.kind },
    });
  }

  function sortMany(ids: string[], target: { kind: "program"; programId: string } | { kind: "not_sales_call" }, source: "event_types_bulk" | "event_types_fold", message: (count: number) => string) {
    const byId = new Map(rows.map((row) => [row.eventType._id as string, row]));
    const requests = ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      const sorting: EventTypeSorting =
        target.kind === "program"
          ? { kind: "program", programId: target.programId as Id<"tenantPrograms">, mode: modeFor(row) }
          : { kind: "not_sales_call" };
      return [{ eventTypeConfigId: row.eventType._id, sorting }];
    });
    const breaking = requests.reduce((sum, request) => {
      const placements = byId.get(request.eventTypeConfigId)?.placements ?? [];
      const sorting = request.sorting;
      return (
        sum +
        placements.filter(
          (placement) => sorting.kind !== "program" || placement.programId !== sorting.programId || placement.mode !== sorting.mode,
        ).length
      );
    }, 0);
    const warning = breaking > 0 ? ` ${breaking} coverage ${breaking === 1 ? "cell shows" : "cells show"} as broken until you change ${breaking === 1 ? "it" : "them"}.` : "";
    return sort(requests, { message: (count) => message(count) + warning, analytics: { source, to: target.kind } });
  }

  async function bulk(target: { kind: "program"; programId: string } | { kind: "not_sales_call" }) {
    const ids = [...selected];
    setSelected(new Set());
    await sortMany(ids, target, "event_types_bulk", (count) =>
      target.kind === "program"
        ? `${count} event ${count === 1 ? "type counts" : "types count"} for ${programName(target.programId)}.`
        : `${count} event ${count === 1 ? "type" : "types"} marked Not a sales call.`,
    );
  }

  async function fold(group: LookalikeGroup, ids: string[]) {
    // Let the rows flash before they fold away.
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    await sortMany(ids, { kind: "not_sales_call" }, "event_types_fold", (count) =>
      `Folded ${count} look-${count === 1 ? "alike" : "alikes"} of ${group.label}: marked Not a sales call.`,
    );
  }

  async function sync() {
    setSyncing(true);
    try {
      const result = await syncNow({});
      posthog.capture("booking_event_types_synced", { status: result.status });
      if (result.status === "skipped") toast("A Calendly sync is already running. It will finish on its own.");
      else
        toast.success(
          `Synced from Calendly: ${result.totalSeen} event ${result.totalSeen === 1 ? "type" : "types"}${result.created ? `, ${result.created} new` : ""}.`,
        );
    } catch (error) {
      reportClientError(error, { flow: "booking_event_types_sync" });
      toast.error(getErrorMessage(error, "Couldn't sync with Calendly. Try again."));
    } finally {
      setSyncing(false);
    }
  }

  const lastSync = Math.max(0, ...coverage.eventTypes.map((eventType) => eventType.lastCalendlySyncedAt ?? 0));
  const notReturned = coverage.eventTypes.filter(
    (eventType) => eventType.calendlySyncStatus === "not_returned" || eventType.calendlySyncStatus === "deleted",
  ).length;
  const switchedOff = coverage.eventTypes.filter((eventType) => eventType.calendlySyncStatus === "inactive").length;

  const emptyText =
    needle !== ""
      ? "No event types match."
      : filter === "unsorted"
        ? "Everything is sorted."
        : filter === "not_sales_call"
          ? "Nothing marked Not a sales call yet."
          : filter === "gone"
            ? "Nothing is gone from Calendly."
            : filter === "sales"
              ? "No event type counts for a program yet. Sort them from Unsorted or the Inbox."
              : "Calendly hasn’t returned any event types yet.";

  return (
    <>
      <section aria-label="Event types" className="@container/et overflow-clip rounded-xl border border-border bg-card">
        <EventTypeTools query={query} onQuery={setQuery} filter={filter} onFilter={setFilter} counts={counts} />
        <SyncLine
          syncedAgo={lastSync ? formatDistanceToNowStrict(lastSync, { addSuffix: true }) : null}
          returned={coverage.eventTypes.length - notReturned}
          notReturned={notReturned}
          switchedOff={switchedOff}
          unsorted={counts.unsorted}
          syncing={syncing}
          onSync={() => void sync()}
        />
        {filter === "looks" ? (
          <LookAlikesView
            groups={groups}
            board={board}
            programName={programName}
            teamName={teamName}
            onFold={fold}
            onOpen={(id) => writeParams({ eventType: id })}
            query={needle}
          />
        ) : (
          <>
            <EventTypesTable
              rows={shown}
              programs={programs}
              selected={selected}
              onSelect={(id, checked) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked) next.add(id);
                  else next.delete(id);
                  return next;
                })
              }
              onSelectAll={(checked) => setSelected(checked ? new Set(shown.map((row) => row.eventType._id as string)) : new Set())}
              onOpen={(id) => writeParams({ eventType: id })}
              onSort={(row, target) => sortOne(row, target, "event_types")}
              emptyText={emptyText}
            />
            {selected.size > 0 ? (
              <BulkBar
                count={selected.size}
                programs={programs}
                onNotSalesCall={() => void bulk({ kind: "not_sales_call" })}
                onProgram={(programId) => void bulk({ kind: "program", programId })}
                onClear={() => setSelected(new Set())}
              />
            ) : null}
          </>
        )}
      </section>
      <EventTypeSheet
        row={openRow}
        config={openConfig}
        board={board}
        programs={programs}
        teamName={teamName}
        onClose={() => writeParams({ eventType: null })}
        onSort={(row, target) => sortOne(row, target, "event_type_sheet")}
      />
    </>
  );
}
