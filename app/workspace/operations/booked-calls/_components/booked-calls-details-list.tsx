"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DetailCard, DetailCardFooter, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { StageChip } from "@/app/workspace/closer/meetings/_components/stage-tone";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { formatBusinessDate, formatClock } from "@/app/workspace/closer/_components/today-time";
import { INITIAL_SOURCE_META } from "@/app/workspace/_components/initial-source-badge";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { cn } from "@/lib/utils";

// The range's bookings as ruled rows: who booked, through which DM closer,
// for which program and when the call is, with the call's attendance as one
// condensed word and the deal's stage as its chip. A row opens in place to
// its details and the links to the deal and the person. The list covers the
// same booked-at window as the numbers above it.

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

function useDebounced(value: string) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

type BookedCallRow = FunctionReturnType<typeof api.operations.bookedCallsDashboard.searchBookedCallsDetails>[number];

export type BookedCallsWindow = { start: number; end: number };
export type DmCloserFilterOption = { key: string; label: string };

/** The call's attendance as one word in its ink; a past call still scheduled is owed (amber). */
function attendance(row: BookedCallRow, now: number) {
  switch (row.meetingStatus) {
    case "held":
      return { word: "Held", ink: "text-stage-held-ink" };
    case "no_show":
      return { word: "No-show", ink: "text-danger-ink" };
    case "canceled":
      return { word: "Canceled", ink: "text-muted-foreground" };
    case "scheduled":
      return row.scheduledAt + row.durationMinutes * 60_000 <= now
        ? { word: "Not recorded", ink: "text-warning-ink" }
        : { word: "Upcoming", ink: "text-stage-booked-ink" };
  }
}

/** "Nov 4, 3:00 PM" in the tenant's time zone; the day is the business day. The year only outside this year. */
function whenLabel(at: number, setting: BusinessDaySetting, today: string) {
  const day = businessDateForInstant(at, setting);
  const date = formatBusinessDate(day, day.slice(0, 4) === today.slice(0, 4)
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
  return `${date}, ${formatClock(at, setting.timeZone)}`;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  );
}

function BookingRow({
  row,
  open,
  onToggle,
  setting,
  today,
  now,
}: {
  row: BookedCallRow;
  open: boolean;
  onToggle: () => void;
  setting: BusinessDaySetting;
  today: string;
  now: number;
}) {
  const detailsId = useId();
  const status = attendance(row, now);
  const dealHref = row.leadId
    ? `/workspace/leads-customers/${row.leadId}?opportunityId=${row.opportunityId}`
    : `/workspace/opportunities/${row.opportunityId}`;
  return (
    <li className={cn("border-b last:border-b-0", open && "bg-accent/40")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={onToggle}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="min-w-0 truncate font-semibold">
          {row.leadLabel}
          {row.leadHandle ? <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">{row.leadHandle}</span> : null}
        </span>
        <span className={cn("text-right font-condensed text-[13px] font-bold tracking-[0.08em] whitespace-nowrap uppercase", status.ink)}>
          {status.word}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "row-span-2 size-4 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
        <span className="min-w-0 truncate text-[13px] text-muted-foreground">
          Call{" "}
          <span className="font-condensed text-sm font-semibold text-foreground tabular-nums">
            {whenLabel(row.scheduledAt, setting, today)}
          </span>{" "}
          · {row.dmCloserLabel ?? "No DM closer"} · {row.programName ?? "No program"}
        </span>
        <span className="flex justify-end">
          {row.dealPosition ? <StageChip position={row.dealPosition} systemLoss={row.dealSystemLoss} /> : null}
        </span>
      </button>
      <div
        id={detailsId}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <div className="border-t bg-muted/30">
            <dl className="grid gap-x-6 gap-y-2.5 px-4 py-3 @md/bookings:grid-cols-2 @2xl/bookings:grid-cols-3">
              <Fact label="Booked">
                <span className="font-condensed text-[15px] font-semibold tabular-nums">{whenLabel(row.bookedAt, setting, today)}</span>
              </Fact>
              <Fact label="Call">
                <span className="font-condensed text-[15px] font-semibold tabular-nums">{whenLabel(row.scheduledAt, setting, today)}</span>
              </Fact>
              <Fact label="Program">{row.programName ?? "None"}</Fact>
              <Fact label="DM team">{row.attributionTeamLabel ?? "None"}</Fact>
              <Fact label="DM closer">{row.dmCloserLabel ?? "None"}</Fact>
              <Fact label="Deal">
                {row.dealPosition ? <StageChip position={row.dealPosition} systemLoss={row.dealSystemLoss} /> : "Not linked"}
              </Fact>
              <Fact label="Initial source">{row.initialSource ? INITIAL_SOURCE_META[row.initialSource].label : "Not recorded"}</Fact>
              <Fact label="Self-reported income">
                {row.selfReportedIncome === null ? (
                  "Not given"
                ) : (
                  <span className="font-condensed text-[15px] font-semibold tabular-nums">{formatWholeNumber(row.selfReportedIncome)}</span>
                )}
              </Fact>
            </dl>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t px-4 py-2 text-sm">
              <Link href={dealHref} className={detailLinkClass} tabIndex={open ? undefined : -1}>
                Open deal
              </Link>
              {row.leadId ? (
                <Link href={`/workspace/leads-customers/${row.leadId}`} className={detailLinkClass} tabIndex={open ? undefined : -1}>
                  Open person
                </Link>
              ) : null}
              <span className="ml-auto text-[13px] text-muted-foreground">Income is self-reported in the DM portal.</span>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

function BookingRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading bookings">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-[54px] items-center gap-3 border-b px-4 last:border-b-0">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

export function BookedCallsDetailsList({
  window,
  dmCloserOptions,
  rangePhrase,
}: {
  window: BookedCallsWindow | undefined;
  dmCloserOptions: DmCloserFilterOption[] | undefined;
  rangePhrase: string;
}) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const today = businessDateForInstant(now, setting);
  const [search, setSearch] = useState("");
  const [dmCloser, setDmCloser] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const debounced = useDebounced(search.trim());
  const isSearching = debounced.length >= 2;

  const baseArgs = useMemo(
    () =>
      window === undefined
        ? undefined
        : {
            start: window.start,
            end: window.end,
            ...(dmCloser === "all" ? {} : { dmCloserId: dmCloser as Id<"dmClosers"> }),
          },
    [window, dmCloser],
  );
  const paginated = usePaginatedQuery(
    api.operations.bookedCallsDashboard.listBookedCallsDetails,
    baseArgs === undefined || isSearching ? "skip" : baseArgs,
    { initialNumItems: PAGE_SIZE },
  );
  const searchResults = useQuery(
    api.operations.bookedCallsDashboard.searchBookedCallsDetails,
    baseArgs !== undefined && isSearching ? { ...baseArgs, searchTerm: debounced } : "skip",
  );

  const fresh: BookedCallRow[] | undefined = isSearching
    ? searchResults
    : paginated.status === "LoadingFirstPage"
      ? undefined
      : paginated.results;
  // A new range, filter or search keeps the last rows on screen, dimmed,
  // until the new ones arrive (DESIGN.md, Kept Data While Reloading).
  const [kept, setKept] = useState<BookedCallRow[] | undefined>(fresh);
  if (fresh !== undefined && fresh !== kept) setKept(fresh);
  const rows = fresh ?? kept;
  const reloading = fresh === undefined && kept !== undefined;
  const filterName = dmCloserOptions?.find((option) => option.key === dmCloser)?.label;

  const emptyTitle = isSearching
    ? `No bookings match “${debounced}” ${rangePhrase}.`
    : filterName
      ? `No bookings through ${filterName} ${rangePhrase}.`
      : `No calls booked ${rangePhrase}.`;

  return (
    <DetailCard
      title="Bookings"
      className="@container/bookings min-w-0"
      metaClassName="w-full @lg/bookings:w-auto"
      meta={
        <div className="flex w-full flex-wrap items-center gap-2 @lg/bookings:w-auto">
          <div className="relative min-w-0 flex-1 @lg/bookings:w-52 @lg/bookings:flex-none">
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSearch("");
              }}
              placeholder="Search people"
              aria-label="Search bookings by person or handle"
              className="h-[30px] pr-7 pl-8 text-[13px]"
            />
            {search ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearch("")}
                className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <Select value={dmCloser} onValueChange={setDmCloser}>
            <SelectTrigger aria-label="Filter by DM closer" size="sm" className="h-[30px] w-40 text-[13px]">
              <SelectValue placeholder="All DM closers" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All DM closers</SelectItem>
                {(dmCloserOptions ?? []).map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {rows === undefined ? (
          <BookingRowsSkeleton />
        ) : rows.length === 0 ? (
          <SectionEmpty title={emptyTitle}>
            {isSearching || filterName ? (
              <button
                type="button"
                className={detailLinkClass}
                onClick={() => {
                  setSearch("");
                  setDmCloser("all");
                }}
              >
                Clear filters
              </button>
            ) : (
              "Bookings appear here as people book through DM closers' links."
            )}
          </SectionEmpty>
        ) : (
          <ul
            aria-label="Bookings"
            aria-busy={reloading}
            className={cn("transition-opacity duration-200", reloading && "opacity-60")}
          >
            {rows.map((row) => (
              <BookingRow
                key={row.meetingId}
                row={row}
                open={openId === row.meetingId}
                onToggle={() => setOpenId((current) => (current === row.meetingId ? null : row.meetingId))}
                setting={setting}
                today={today}
                now={now}
              />
            ))}
          </ul>
        )}
        {rows && rows.length > 0 ? (
          <DetailCardFooter className="mt-auto text-[13px] font-normal">
            <span>
              {isSearching
                ? `${formatWholeNumber(rows.length)} ${rows.length === 1 ? "match" : "matches"}`
                : paginated.status === "Exhausted"
                  ? `${formatWholeNumber(rows.length)} ${rows.length === 1 ? "booking" : "bookings"}`
                  : `Showing ${formatWholeNumber(rows.length)}`}
            </span>
            {!isSearching && (paginated.status === "CanLoadMore" || paginated.status === "LoadingMore") ? (
              <Button
                size="sm"
                variant="outline"
                disabled={paginated.status === "LoadingMore"}
                onClick={() => paginated.loadMore(PAGE_SIZE)}
              >
                {paginated.status === "LoadingMore" ? "Loading…" : `Show ${PAGE_SIZE} more`}
              </Button>
            ) : null}
          </DetailCardFooter>
        ) : null}
      </div>
    </DetailCard>
  );
}
