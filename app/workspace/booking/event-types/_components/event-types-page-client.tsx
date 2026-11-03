"use client";

import { useDeferredValue, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { SearchIcon, XIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { usePageTitle } from "@/hooks/use-page-title";
import { cn } from "@/lib/utils";
import {
  buildBoard,
  eventTypeStatus,
  modeOf,
  sortingLabel,
  type Coverage,
  type EventTypeSorting,
  type EventTypeStatus,
} from "../../_components/booking-model";
import { useSortEventTypes } from "../../_components/use-sort-event-types";
import { EVENT_TYPES_DESCRIPTION } from "./event-types-layout";
import { EventTypesPageSkeleton } from "./event-types-page-skeleton";
import { EventTypesTable, type EventTypeGroup, type EventTypeRow } from "./event-types-table";

const EventTypeConfigDialog = dynamic(() =>
  import("../../_components/event-type-config-dialog").then((module) => ({
    default: module.EventTypeConfigDialog,
  })),
);

const FILTERS = [
  { value: "sorted", label: "Sorted" },
  { value: "unsorted", label: "Unsorted" },
  { value: "not_sales_call", label: "Not a sales call" },
  { value: "gone", label: "Gone" },
  { value: "all", label: "All" },
] as const;

type Filter = (typeof FILTERS)[number]["value"];

function parseFilter(value: string | null): Filter {
  return FILTERS.find((filter) => filter.value === value)?.value ?? "sorted";
}

const STATUS_GROUP_LABEL: Record<Exclude<EventTypeStatus, "sorted">, string> = {
  unsorted: "Unsorted",
  not_sales_call: "Not a sales call",
  gone: "Gone from Calendly",
};

const EMPTY: Record<Filter, { title: string; hint: React.ReactNode }> = {
  sorted: {
    title: "No event types are sorted yet.",
    hint: (
      <>
        Sort them into programs from the{" "}
        <Link href="/workspace/booking/inbox" className="font-semibold text-foreground underline decoration-foreground/40 underline-offset-[3px]">
          Inbox
        </Link>
        .
      </>
    ),
  },
  unsorted: { title: "Nothing to sort.", hint: "New Calendly event types show here until they're sorted." },
  not_sales_call: {
    title: "Nothing is set aside as not a sales call.",
    hint: "Event types you mark as not a sales call show here, and can be brought back.",
  },
  gone: { title: "Calendly still offers every unsorted event type.", hint: null },
  all: { title: "No event types yet.", hint: "They arrive with each Calendly sync." },
};

type FullConfig = FunctionReturnType<typeof api.eventTypeConfigs.queries.listEventTypeConfigs>[number];

const byName = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function EventTypesPageClient() {
  usePageTitle("Event types · Booking setup");
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  if (coverage === undefined) {
    return <EventTypesPageSkeleton />;
  }
  return <EventTypesPage coverage={coverage} />;
}

function EventTypesPage({ coverage }: { coverage: Coverage }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filter = parseFilter(searchParams.get("filter"));
  // ?q= seeds the search: the coverage board's program menu links here with it.
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  function setFilter(next: Filter) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "sorted") params.delete("filter");
    else params.set("filter", next);
    const search = params.toString();
    // Written in place, so a filter change never navigates.
    window.history.replaceState(null, "", `${pathname}${search ? `?${search}` : ""}`);
  }

  const board = useMemo(() => buildBoard(coverage), [coverage]);
  const programsById = useMemo(
    () => new Map(coverage.programs.map((program) => [program._id as string, program])),
    [coverage.programs],
  );
  const programName = useMemo(
    () => (programId: string) => {
      const program = programsById.get(programId);
      if (!program) return "A removed program";
      return program.archivedAt !== undefined ? `${program.name} (archived)` : program.name;
    },
    [programsById],
  );

  const rows = useMemo<EventTypeRow[]>(
    () =>
      coverage.eventTypes.map((eventType) => ({
        eventType,
        status: eventTypeStatus(eventType),
        placements: board.placements.get(eventType._id) ?? [],
      })),
    [coverage.eventTypes, board.placements],
  );

  const counts = useMemo(() => {
    const result: Record<Filter, number> = { sorted: 0, unsorted: 0, not_sales_call: 0, gone: 0, all: rows.length };
    for (const row of rows) result[row.status] += 1;
    return result;
  }, [rows]);

  const shown = useMemo(() => {
    return rows.filter((row) => {
      if (filter !== "all" && row.status !== filter) return false;
      if (!deferredQuery) return true;
      const program = row.eventType.bookingProgramId ? programName(row.eventType.bookingProgramId) : "";
      const haystack = `${row.eventType.displayName} ${row.eventType.calendlyName ?? ""} ${program}`.toLowerCase();
      return haystack.includes(deferredQuery);
    });
  }, [rows, filter, deferredQuery, programName]);

  const groups = useMemo(
    () => groupRows(shown, filter, coverage.programs, programName),
    [shown, filter, coverage.programs, programName],
  );

  // The editor needs the full config; one subscription serves every row. The
  // dialog gets the doc as it was when opened: it resets its form whenever
  // `config` changes, and this list re-sends every doc on any change.
  const fullConfigs = useQuery(api.eventTypeConfigs.queries.listEventTypeConfigs, {});
  const [editor, setEditor] = useState<{ id: string; open: boolean; config: FullConfig | null } | null>(null);
  if (editor && editor.config === null && fullConfigs) {
    const found = fullConfigs.find((config) => config._id === editor.id);
    if (found) setEditor({ ...editor, config: found });
  }

  const sort = useSortEventTypes();
  function sortRow(row: EventTypeRow, sorting: EventTypeSorting) {
    const name = row.eventType.displayName;
    void sort([{ eventTypeConfigId: row.eventType._id, sorting }], {
      message: () =>
        sorting.kind === "unsorted"
          ? row.status === "not_sales_call"
            ? `${name} is back in the inbox.`
            : `${name} moved to the inbox.`
          : sorting.kind === "not_sales_call"
            ? `${name} set aside as not a sales call.`
            : `${name} sorted into ${sortingLabel(sorting, programsById)}.`,
      analytics: { source: "event_types", to: sorting.kind },
    });
  }

  const filterLabel = FILTERS.find((entry) => entry.value === filter)?.label ?? "Sorted";
  const total = filter === "all" ? rows.length : counts[filter];

  return (
    <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
      <div className="dark rounded-xl bg-board text-board-foreground [&>div]:mx-0! [&>div]:border-t-0!">
        <div className="-mx-4 flex flex-wrap items-center gap-2.5 border-t border-board-line px-4 py-2.5 @lg:-mx-[18px] @lg:px-[18px]">
          <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
            <ToggleGroup
              type="single"
              value={filter}
              onValueChange={(next) => {
                if (next) setFilter(parseFilter(next));
              }}
              aria-label="Show event types"
              className="h-[34px] rounded-[7px] border border-board-foreground/15 bg-board-raised p-0.5"
            >
              {FILTERS.map((entry) => (
                <ToggleGroupItem
                  key={entry.value}
                  value={entry.value}
                  className="h-full gap-1.5 rounded-[5px]! px-2.5 text-[13px] whitespace-nowrap text-board-muted hover:bg-board-foreground/10 hover:text-board-foreground data-[state=on]:bg-board-foreground/15 data-[state=on]:text-board-foreground"
                >
                  {entry.label}
                  <span
                    className={cn(
                      "font-condensed text-[14px] font-semibold tabular-nums",
                      entry.value === "unsorted" && counts.unsorted > 0 && "text-warning",
                    )}
                  >
                    {counts[entry.value]}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <label className="flex h-[34px] w-full items-center gap-2 rounded-[7px] border border-board-foreground/15 bg-board-raised px-3 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 @3xl:ml-auto @3xl:w-[16rem]">
            <SearchIcon className="size-4 shrink-0 text-board-muted" aria-hidden="true" />
            <span className="sr-only">Search event types by name</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
              placeholder="Search event types"
              className="h-full min-w-0 flex-1 appearance-none bg-transparent text-[13px] text-board-foreground caret-primary-ink outline-none placeholder:text-board-muted [&::-webkit-search-cancel-button]:appearance-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="-mr-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded-[5.6px] text-board-muted outline-none hover:bg-board-foreground/10 hover:text-board-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <XIcon className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </label>
        </div>
      </div>

      <Card className="@container/et gap-0 overflow-hidden py-0">
        <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2">
          <h2 className="text-[15px] font-semibold">
            {filter === "all" ? "All event types" : filterLabel === "Gone" ? "Gone from Calendly" : filterLabel}
          </h2>
          <span className="ml-auto text-[13px] text-muted-foreground">
            {deferredQuery ? (
              <>
                <Figure>{shown.length}</Figure> of <Figure>{total}</Figure> match “{query.trim()}”
              </>
            ) : (
              <>
                <Figure>{shown.length}</Figure> {shown.length === 1 ? "event type" : "event types"}
                {filter === "sorted" && shown.length > 0 ? " · by program, Priority first" : null}
                {filter === "gone" && shown.length > 0 ? " · never sorted, kept for history" : null}
              </>
            )}
          </span>
        </div>

        {shown.length === 0 ? (
          deferredQuery ? (
            <SectionEmpty title={`No ${filter === "all" ? "" : `${filterLabel.toLowerCase()} `}event types match “${query.trim()}”.`}>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setQuery("")}>
                Clear search
              </Button>
            </SectionEmpty>
          ) : (
            <SectionEmpty title={EMPTY[filter].title}>{EMPTY[filter].hint}</SectionEmpty>
          )
        ) : (
          <EventTypesTable
            groups={groups}
            programName={programName}
            onEdit={(row) => setEditor({ id: row.eventType._id, open: true, config: null })}
            onSort={sortRow}
          />
        )}
      </Card>

      {editor?.config ? (
        <EventTypeConfigDialog
          open={editor.open}
          onOpenChange={(open) => setEditor((current) => (current ? { ...current, open } : null))}
          config={editor.config}
        />
      ) : null}
    </div>
  );
}

function Figure({ children }: { children: React.ReactNode }) {
  return <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">{children}</span>;
}

/**
 * Sorted rows group by program in the programs' display order, Priority
 * before Standard, then by name. The other statuses are one group each;
 * a filtered view of one status needs no heading.
 */
function groupRows(
  rows: readonly EventTypeRow[],
  filter: Filter,
  programs: Coverage["programs"],
  programName: (programId: string) => string,
): EventTypeGroup[] {
  const programOrder = new Map(programs.map((program, index) => [program._id as string, index]));
  const sortedByProgram = new Map<string, EventTypeRow[]>();
  const byStatus: Record<Exclude<EventTypeStatus, "sorted">, EventTypeRow[]> = {
    unsorted: [],
    not_sales_call: [],
    gone: [],
  };
  for (const row of rows) {
    if (row.status === "sorted") {
      const programId = row.eventType.bookingProgramId ?? "";
      const list = sortedByProgram.get(programId) ?? [];
      list.push(row);
      sortedByProgram.set(programId, list);
    } else {
      byStatus[row.status].push(row);
    }
  }
  const byNameOnly = (left: EventTypeRow, right: EventTypeRow) =>
    byName.compare(left.eventType.displayName, right.eventType.displayName);
  const byModeThenName = (left: EventTypeRow, right: EventTypeRow) =>
    Number(modeOf(left.eventType) === "extended") - Number(modeOf(right.eventType) === "extended") ||
    byNameOnly(left, right);

  const programGroups: EventTypeGroup[] = [...sortedByProgram.entries()]
    .sort(
      ([left], [right]) =>
        (programOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (programOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(([programId, list]) => ({
      key: `program:${programId}`,
      label: programName(programId),
      rows: list.sort(byModeThenName),
    }));

  const statusGroup = (status: Exclude<EventTypeStatus, "sorted">, labelled: boolean): EventTypeGroup[] =>
    byStatus[status].length === 0
      ? []
      : [{ key: status, label: labelled ? STATUS_GROUP_LABEL[status] : null, rows: byStatus[status].sort(byNameOnly) }];

  if (filter === "sorted") return programGroups;
  if (filter === "all") {
    return [...statusGroup("unsorted", true), ...programGroups, ...statusGroup("not_sales_call", true), ...statusGroup("gone", true)];
  }
  return statusGroup(filter, false);
}
