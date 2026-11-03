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
import { getMemberDisplayName } from "@/app/workspace/_components/member-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { meetingAttendanceDisplay, meetingStatusConfig, type MeetingAttendanceStatus } from "@/lib/status-config";
import { cn } from "@/lib/utils";
import { formatCount } from "./sales-format";

// The range's meetings as ruled rows that open in place: who, their phone
// closer, when, and the attendance word in its ink. Shares the dashboard's
// exact window, so the figures above and this list cover the same calls. Two
// or more typed characters switch from the paginated list to the search.

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

type SalesCallRow = FunctionReturnType<typeof api.operations.salesCallsDashboard.searchSalesCallsMeetings>[number];

export type SalesCallsWindow = { start: number; end: number };
export type CloserFilterOption = { key: string; label: string };

/** The attendance word's ink: amber for what is owed, red for a no-show. */
const STATUS_INK: Record<MeetingAttendanceStatus, string> = {
  scheduled: "text-foreground",
  held: "text-muted-foreground",
  canceled: "text-muted-foreground",
  no_show: "text-danger-ink",
  not_recorded: "text-warning-ink",
};

function useMeetingTime(timeZone: string, now: number) {
  return useMemo(() => {
    const year = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(now);
    const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
    const dayWithYear = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
    const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
    const yearOf = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" });
    return (instant: number) => {
      const dayText = yearOf.format(instant) === year ? day.format(instant) : dayWithYear.format(instant);
      return { day: dayText, time: time.format(instant) };
    };
  }, [timeZone, now]);
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-3 py-1">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function MeetingRow({
  row,
  open,
  onToggle,
  when,
  now,
}: {
  row: SalesCallRow;
  open: boolean;
  onToggle: () => void;
  when: (instant: number) => { day: string; time: string };
  now: number;
}) {
  const detailId = useId();
  const status = meetingAttendanceDisplay({ ...row, status: row.meetingStatus }, now);
  const at = when(row.scheduledAt);
  const closer = getMemberDisplayName(row.assignedCloser);
  const dealHref = row.leadId
    ? `/workspace/leads-customers/${row.leadId}?opportunityId=${row.opportunityId}`
    : `/workspace/opportunities/${row.opportunityId}`;

  return (
    <li className={cn("border-b last:border-b-0", open && "bg-accent/40")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto_1.25rem] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @2xl/meetings:min-h-11 @2xl/meetings:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_9.5rem_7.5rem_1.25rem]"
      >
        <span className="min-w-0 truncate font-semibold">{row.leadName}</span>
        <span className="col-start-1 row-start-2 min-w-0 truncate text-[13px] text-muted-foreground @2xl/meetings:col-start-auto @2xl/meetings:row-start-auto">
          {closer}
          <span className="@2xl/meetings:hidden">
            {" · "}
            {at.day} · {at.time}
          </span>
        </span>
        <time
          dateTime={new Date(row.scheduledAt).toISOString()}
          className="hidden font-condensed text-[15px] font-semibold whitespace-nowrap tabular-nums @2xl/meetings:block"
        >
          {at.day} <span className="font-medium text-muted-foreground">· {at.time}</span>
        </time>
        <span
          className={cn(
            "row-span-2 text-right font-condensed text-[13px] font-bold tracking-[0.08em] whitespace-nowrap uppercase @2xl/meetings:row-span-1",
            STATUS_INK[status],
          )}
        >
          {meetingStatusConfig[status].label}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "row-span-2 size-4 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none @2xl/meetings:row-span-1",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        id={detailId}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t bg-muted/30 px-4 py-2.5">
            <dl className="grid gap-x-6 @2xl/meetings:grid-cols-2">
              <DetailRow label="Scheduled">
                <span className="font-condensed text-[15px] font-semibold tabular-nums">
                  {at.day} · {at.time}
                </span>
                <span className="text-[13px] text-muted-foreground"> · {formatCount(row.durationMinutes)} min</span>
              </DetailRow>
              <DetailRow label="Phone closer">{closer}</DetailRow>
              <DetailRow label="Deal stage">
                {row.dealPosition ? <StageChip position={row.dealPosition} systemLoss={row.dealSystemLoss} /> : <span className="text-muted-foreground">No deal linked</span>}
              </DetailRow>
              <DetailRow label="Booked for">
                {row.bookingProgramName ?? <span className="text-muted-foreground">No program mapped for this Calendly event type</span>}
              </DetailRow>
              <DetailRow label="Sold">{row.soldProgramName ?? <Dash />}</DetailRow>
              <DetailRow label="DM team">{row.attributionTeamName ?? <Dash />}</DetailRow>
              <DetailRow label="DM closer">{row.dmCloserName ?? <Dash />}</DetailRow>
              <DetailRow label="Setter">{row.slackUserLabel ?? <Dash />}</DetailRow>
            </dl>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 border-t pt-2 text-sm">
              <Link href={dealHref} className={detailLinkClass}>
                Open deal
              </Link>
              {row.leadId ? (
                <Link href={`/workspace/leads-customers/${row.leadId}`} className={detailLinkClass}>
                  Open person
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

export function MeetingsCard({
  window: callWindow,
  closerOptions,
  rangePhrase,
}: {
  window: SalesCallsWindow | undefined;
  closerOptions: CloserFilterOption[] | undefined;
  /** "today", "this week", "in this range". */
  rangePhrase: string;
}) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const when = useMeetingTime(setting.timeZone, now);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [closerFilter, setCloserFilter] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => setSearch(draft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [draft]);

  const term = search.trim();
  const isSearching = term.length >= 2;
  const closerArg = useMemo(
    () => (closerFilter === "all" ? {} : { closerId: closerFilter as Id<"users"> }),
    [closerFilter],
  );

  const paginated = usePaginatedQuery(
    api.operations.phoneSales.listPhoneSalesMeetings,
    callWindow === undefined || isSearching
      ? "skip"
      : { scheduledFrom: callWindow.start, scheduledTo: callWindow.end, ...closerArg },
    { initialNumItems: PAGE_SIZE },
  );
  const searchResults = useQuery(
    api.operations.salesCallsDashboard.searchSalesCallsMeetings,
    callWindow !== undefined && isSearching
      ? { searchTerm: term, start: callWindow.start, end: callWindow.end, ...closerArg }
      : "skip",
  );

  const rows: SalesCallRow[] = isSearching ? (searchResults ?? []) : paginated.results;
  const loading = callWindow === undefined || (isSearching ? searchResults === undefined : paginated.status === "LoadingFirstPage");
  const filtered = isSearching || closerFilter !== "all";
  const closerLabel = closerOptions?.find((option) => option.key === closerFilter)?.label;

  const emptyTitle = isSearching
    ? `No meetings match “${term}” ${rangePhrase}.`
    : closerFilter !== "all"
      ? `No meetings for ${closerLabel ?? "this phone closer"} ${rangePhrase}.`
      : `No meetings ${rangePhrase}.`;

  const shownWords = `${formatCount(rows.length)} meeting${rows.length === 1 ? "" : "s"}`;

  return (
    <DetailCard title="Meetings" meta={loading ? null : isSearching ? `${shownWords} found` : shownWords} className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <div className="relative min-w-0 flex-1 basis-56">
          <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft("");
            }}
            placeholder="Search by name"
            aria-label="Search meetings by lead or prospect name"
            className="h-8 pr-8 pl-8"
          />
          {draft ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setDraft("")}
              className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-[5px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <Select value={closerFilter} onValueChange={setCloserFilter}>
          <SelectTrigger aria-label="Filter by phone closer" className="h-8 w-44 text-[13px]" size="sm">
            <SelectValue placeholder="All phone closers" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All phone closers</SelectItem>
              {(closerOptions ?? []).map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="@container/meetings">
        {loading ? (
          <div role="status" aria-label="Loading meetings" className="flex flex-col">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex min-h-11 items-center gap-4 border-b px-4 py-2 last:border-b-0">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="ml-auto h-3.5 w-20" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <SectionEmpty title={emptyTitle}>
            {filtered ? (
              <button
                type="button"
                className={cn(detailLinkClass, "mt-1 text-[13px]")}
                onClick={() => {
                  setDraft("");
                  setSearch("");
                  setCloserFilter("all");
                }}
              >
                Clear filters
              </button>
            ) : (
              "Calls appear here as people book through Calendly."
            )}
          </SectionEmpty>
        ) : (
          <ul aria-label="Meetings in this range" className="flex flex-col">
            {rows.map((row) => (
              <MeetingRow
                key={row.meetingId}
                row={row}
                when={when}
                now={now}
                open={openId === row.meetingId}
                onToggle={() => setOpenId((current) => (current === row.meetingId ? null : row.meetingId))}
              />
            ))}
          </ul>
        )}
      </div>

      {!loading && rows.length > 0 ? (
        <DetailCardFooter className="font-normal">
          <span className="text-[13px]">
            {isSearching
              ? `${shownWords} matching “${term}”`
              : paginated.status === "Exhausted"
                ? `All ${shownWords} ${rangePhrase}`
                : `Showing ${shownWords}`}
          </span>
          {!isSearching && paginated.status === "CanLoadMore" ? (
            <Button size="sm" variant="outline" onClick={() => paginated.loadMore(PAGE_SIZE)}>
              Show more
            </Button>
          ) : null}
          {!isSearching && paginated.status === "LoadingMore" ? (
            <span role="status" className="flex items-center gap-2 text-[13px]">
              <Spinner aria-hidden="true" />
              Loading more…
            </span>
          ) : null}
        </DetailCardFooter>
      ) : null}
    </DetailCard>
  );
}
