"use client";

import { useEffect, useState, type Ref } from "react";
import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import { SearchIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { CloserLookupTab } from "@/convex/closer/pipelineTabs";
import { addBusinessDays, businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { formatCash, NO_PROGRAM, programLabel } from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { formatBusinessDate } from "@/app/workspace/closer/_components/today-time";
import { dealHref, NextStep, ROW_LINK, StageWord } from "./deal-cells";
import { useKeptQuery } from "./use-kept-query";

export type LookupFilters = {
  tab: CloserLookupTab;
  /** A program's key, "none" for the deals with no program, or null for any. */
  programKey: string | null;
  search: string;
};

type Lookup = FunctionReturnType<typeof api.closer.pipeline.listMyOpportunities>;
type LookupRow = Lookup["rows"][number];

const PAGE = 25;
const ANY_PROGRAM = "__any";
const SEARCH_PAUSE_MS = 250;

const TABS: Array<{ value: CloserLookupTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

/**
 * All deals: every deal the closer owns, by outcome tab (with counts), by
 * program and by person, the last active first. A row opens the deal on the
 * person's page. More rows load in steps of 25; while a filter or a step
 * loads, the rows already shown stay, dimmed.
 */
export function DealsLookup({
  filters,
  onFiltersChange,
  now,
  setting,
  headingRef,
}: {
  filters: LookupFilters;
  onFiltersChange: (filters: LookupFilters) => void;
  now: number;
  setting: BusinessDaySetting;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  // A new filter starts from the first page again.
  const filterKey = `${filters.tab}|${filters.programKey}|${filters.search}`;
  const [limit, setLimit] = useState(PAGE);
  const [limitKey, setLimitKey] = useState(filterKey);
  if (limitKey !== filterKey) {
    setLimitKey(filterKey);
    setLimit(PAGE);
  }

  // The search box types freely and sends its text after a pause. A search
  // set from outside (the URL, a program link) replaces what's typed.
  const [draft, setDraft] = useState(filters.search);
  const [sentSearch, setSentSearch] = useState(filters.search);
  if (sentSearch !== filters.search) {
    setSentSearch(filters.search);
    if (filters.search !== draft.trim()) setDraft(filters.search);
  }
  useEffect(() => {
    const term = draft.trim();
    if (term === filters.search) return;
    const timer = setTimeout(() => onFiltersChange({ ...filters, search: term }), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [draft, filters, onFiltersChange]);

  const { data, isStale } = useKeptQuery(api.closer.pipeline.listMyOpportunities, {
    tab: filters.tab,
    programKey: filters.programKey ?? undefined,
    search: filters.search === "" ? undefined : filters.search,
    limit,
  });

  const programs = [...(data?.programs ?? [])].sort(
    (a, b) =>
      Number(a.programKey === NO_PROGRAM) - Number(b.programKey === NO_PROGRAM) ||
      programLabel(a.programName).localeCompare(programLabel(b.programName)),
  );
  const selectedProgram =
    filters.programKey === null
      ? null
      : (programs.find((program) => program.programKey === filters.programKey) ?? null);
  const filtered = filters.programKey !== null || filters.search !== "";

  return (
    <section
      aria-labelledby="all-deals-title"
      className="scroll-mt-4 rounded-xl border bg-card text-sm text-card-foreground"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <h2
          id="all-deals-title"
          ref={headingRef}
          tabIndex={-1}
          className="mr-1 rounded-sm text-[15px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          All deals
        </h2>
        <ToggleGroup
          type="single"
          size="sm"
          value={filters.tab}
          onValueChange={(next) => {
            const tab = TABS.find((entry) => entry.value === next)?.value;
            if (tab) onFiltersChange({ ...filters, tab });
          }}
          aria-label="Deals by outcome"
          className="rounded-[7px] border bg-background p-0.5"
        >
          {TABS.map((entry) => (
            <ToggleGroupItem
              key={entry.value}
              value={entry.value}
              className="h-6 gap-1 rounded-[5px]! px-2.5 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]"
            >
              {entry.label}
              {data ? <span className="tabular-nums">{data.counts[entry.value]}</span> : null}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Select
          value={filters.programKey ?? ANY_PROGRAM}
          onValueChange={(next) =>
            onFiltersChange({ ...filters, programKey: next === ANY_PROGRAM ? null : next })
          }
          disabled={data === undefined}
        >
          <SelectTrigger size="sm" aria-label="Program" className="h-[30px] max-w-[16rem] min-w-[9.5rem] rounded-[7px] text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={ANY_PROGRAM}>All programs</SelectItem>
            {programs.length > 0 ? <SelectSeparator /> : null}
            {programs.map((program) => (
              <SelectItem key={program.programKey} value={program.programKey}>
                {programLabel(program.programName)}
              </SelectItem>
            ))}
            {filters.programKey !== null && selectedProgram === null && data ? (
              <SelectItem value={filters.programKey}>A program with no deals</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        <InputGroup className="h-[30px] w-full rounded-[7px] sm:w-60">
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search people"
            aria-label="Search people"
            className="text-[13px]"
          />
        </InputGroup>
      </header>

      {data === undefined ? (
        <LookupSkeleton />
      ) : data.rows.length === 0 ? (
        <SectionEmpty title={emptyTitle(filters, data, selectedProgram?.programName)}>
          {filtered ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => onFiltersChange({ tab: "all", programKey: null, search: "" })}
            >
              Clear filters
            </Button>
          ) : null}
        </SectionEmpty>
      ) : (
        <div aria-busy={isStale} className={cn("transition-opacity duration-200", isStale && "opacity-60")}>
          <LookupTable rows={data.rows} now={now} setting={setting} />
          <LookupList rows={data.rows} now={now} setting={setting} />
          <footer className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t px-4 py-2 text-[13px] text-muted-foreground">
            <span className="tabular-nums">
              {data.rows.length < data.matched
                ? `Showing ${data.rows.length} of ${data.matched}`
                : `${data.matched} ${data.matched === 1 ? "deal" : "deals"}`}
              {data.isSearchPartial ? " · the first matches only; add to the search to narrow it" : ""}
              {data.isPartial ? " · your oldest deals aren't included" : ""}
            </span>
            {data.rows.length < data.matched ? (
              <Button
                variant="outline"
                size="sm"
                disabled={isStale}
                onClick={() => setLimit(data.rows.length + PAGE)}
              >
                Show {Math.min(PAGE, data.matched - data.rows.length)} more
              </Button>
            ) : null}
          </footer>
        </div>
      )}
    </section>
  );
}

function emptyTitle(filters: LookupFilters, data: Lookup, programName: string | null | undefined) {
  const which = filters.tab === "all" ? "" : `${filters.tab} `;
  if (filters.search !== "") return `No ${which}deals for “${filters.search}”.`;
  if (filters.programKey !== null) {
    return filters.programKey === NO_PROGRAM
      ? `No ${which}deals with no program.`
      : `No ${which}deals in ${programName ?? "this program"}.`;
  }
  if (data.counts.all === 0) return "No deals yet.";
  return `No ${which}deals.`;
}

/** "Today", "Yesterday", "Oct 27", or "Oct 27, 2025" from another year. */
function activityLabel(at: number, now: number, setting: BusinessDaySetting) {
  const today = businessDateForInstant(now, setting);
  const day = businessDateForInstant(at, setting);
  if (day === today) return "Today";
  if (day === addBusinessDays(today, -1)) return "Yesterday";
  return formatBusinessDate(
    day,
    day.slice(0, 4) === today.slice(0, 4)
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}

function paidLabel(row: LookupRow) {
  return row.paid.map((entry) => formatCash(entry.amountMinor, entry.currency)).join(" · ");
}

type RowsProps = { rows: LookupRow[]; now: number; setting: BusinessDaySetting };

/** md and up: the deals as a table. */
function LookupTable({ rows, now, setting }: RowsProps) {
  return (
    <Table className="hidden table-fixed md:table">
      <colgroup>
        <col />
        <col className="w-[18%]" />
        <col className="w-[132px]" />
        <col className="w-[108px]" />
        <col className="w-[27%]" />
        <col className="w-[112px]" />
      </colgroup>
      <TableHeader>
        <TableRow className="h-8 hover:bg-transparent">
          {["Person", "Program", "Stage", "Last activity", "Next step", "Paid"].map((label, index) => (
            <TableHead
              key={label}
              className={cn(
                "h-8 font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase",
                index === 0 && "pl-4",
                index === 5 && "pr-4 text-right",
              )}
            >
              {label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.opportunityId} className="relative h-11 hover:bg-accent/60">
            <TableCell className="truncate pl-4">
              <Link href={dealHref(row.leadId, row.opportunityId)} className={cn(ROW_LINK, "font-semibold")}>
                {row.personName}
              </Link>
            </TableCell>
            <TableCell className={cn("truncate", row.programName === null && "text-muted-foreground")}>
              {programLabel(row.programName)}
            </TableCell>
            <TableCell className="truncate">
              <StageWord position={row.position} systemLoss={row.systemLoss} />
            </TableCell>
            <TableCell className="font-condensed text-sm font-semibold tracking-[0.02em] text-muted-foreground tabular-nums">
              {activityLabel(row.lastActivityAt, now, setting)}
            </TableCell>
            <TableCell className="truncate">
              {row.nextStep === null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className="flex min-w-0">
                  <NextStep next={row.nextStep} now={now} setting={setting} />
                </span>
              )}
            </TableCell>
            <TableCell className="truncate pr-4 text-right font-condensed text-[15px] font-semibold tabular-nums">
              {paidLabel(row)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Below md: the deals as a stacked list. */
function LookupList({ rows, now, setting }: RowsProps) {
  return (
    <ul className="md:hidden">
      {rows.map((row) => {
        const paid = paidLabel(row);
        return (
          <li
            key={row.opportunityId}
            className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t px-4 py-2.5 first:border-t-0 hover:bg-accent/60"
          >
            <Link
              href={dealHref(row.leadId, row.opportunityId)}
              className={cn(ROW_LINK, "truncate font-semibold")}
            >
              {row.personName}
            </Link>
            <StageWord position={row.position} systemLoss={row.systemLoss} className="justify-self-end" />
            <span className="truncate text-[13px] text-muted-foreground">
              {programLabel(row.programName)} · {activityLabel(row.lastActivityAt, now, setting)}
            </span>
            <span className="justify-self-end font-condensed text-[15px] font-semibold tabular-nums">{paid}</span>
            {row.nextStep !== null ? (
              <span className="col-span-2 flex min-w-0 text-[13px]">
                <NextStep next={row.nextStep} now={now} setting={setting} />
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function LookupSkeleton() {
  return (
    <div role="status" aria-label="Loading deals">
      <div className="hidden h-8 border-b md:block" />
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="flex h-11 items-center gap-6 border-t px-4 first:border-t-0">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="hidden h-4 w-28 md:block" />
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="hidden h-4 w-48 md:block" />
        </div>
      ))}
    </div>
  );
}
