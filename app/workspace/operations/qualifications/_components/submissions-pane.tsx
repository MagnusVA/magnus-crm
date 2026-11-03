"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import { DEAL_POSITIONS, type DealPosition } from "@/convex/opportunities/stages";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/app/workspace/closer/_components/today-time";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { StageWord } from "@/app/workspace/closer/pipeline/_components/deal-cells";
import { MemberAvatar } from "@/app/workspace/_components/member-avatar";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { eventTime, platformLabel, sentenceCase } from "./qualifications-format";

// The desk's right pane: the qualifications in the range, newest first, for
// every setter or the one chosen on the left. A row opens in place.

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

type SubmissionRow = FunctionReturnType<typeof api.operations.qualifications.searchQualificationQueue>[number];

export type QualificationWindow = { qualifiedAfter: number; qualifiedBefore: number };
export type StageFilter = DealPosition | "all";

const COLUMNS_WITH_SETTER =
  "@2xl/subs:grid-cols-[5.75rem_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.85fr)_8.5rem_1rem]";
const COLUMNS_ONE_SETTER = "@2xl/subs:grid-cols-[5.75rem_minmax(0,1.7fr)_minmax(0,0.9fr)_8.5rem_1rem]";

function isPosition(value: string): value is DealPosition {
  return (DEAL_POSITIONS as readonly string[]).includes(value);
}

function resultWords(kind: SubmissionRow["resultKind"]) {
  if (kind === "created_opportunity") return "Created a deal";
  if (kind === "duplicate_pending") return "Duplicate pending";
  if (kind === "already_booked") return "Already booked";
  return "Not linked to a deal";
}

/** Waits until typing pauses before the search reaches the query. */
function useDebounced(value: string) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

export function SubmissionsPane({
  eventWindow,
  failed,
  setter,
  stage,
  onStageChange,
  onClearSetter,
  rangePhrase,
  qualified,
}: {
  eventWindow: QualificationWindow | undefined;
  /** The report failed with nothing kept, so the window never arrives. */
  failed: boolean;
  /** The setter chosen on the left, or null for everyone. */
  setter: { key: string; label: string } | null;
  stage: StageFilter;
  onStageChange: (stage: StageFilter) => void;
  onClearSetter: () => void;
  /** "today", "this week", "in this range". */
  rangePhrase: string;
  /** How many the selection qualified in the range, from the dashboard. */
  qualified: number | undefined;
}) {
  const [draft, setDraft] = useState("");
  const search = useDebounced(draft).trim();
  const isSearching = search.length >= 2;

  // The queue takes one primary filter: the setter or the stage, never both.
  const baseArgs = useMemo(
    () =>
      eventWindow === undefined
        ? undefined
        : {
            ...(setter ? { slackUserId: setter.key } : stage === "all" ? {} : { positionFilter: stage }),
            qualifiedAfter: eventWindow.qualifiedAfter,
            qualifiedBefore: eventWindow.qualifiedBefore,
          },
    [eventWindow, setter, stage],
  );

  const paginated = usePaginatedQuery(
    api.operations.qualifications.listQualificationQueue,
    baseArgs === undefined || isSearching ? "skip" : baseArgs,
    { initialNumItems: PAGE_SIZE },
  );
  const searchResults = useQuery(
    api.operations.qualifications.searchQualificationQueue,
    baseArgs !== undefined && isSearching ? { ...baseArgs, searchTerm: search } : "skip",
  );

  // The queue returns one row per page to bound each read, so the pane asks
  // for pages until it holds the rows it means to show.
  const argsKey = JSON.stringify([baseArgs, isSearching]);
  const [target, setTarget] = useState({ key: argsKey, rows: PAGE_SIZE });
  if (target.key !== argsKey) setTarget({ key: argsKey, rows: PAGE_SIZE });
  const { status, loadMore } = paginated;
  const loadedCount = paginated.results.length;
  useEffect(() => {
    if (!isSearching && status === "CanLoadMore" && loadedCount < target.rows) loadMore(PAGE_SIZE);
  }, [isSearching, status, loadedCount, target.rows, loadMore]);

  // A new filter keeps the last rows on screen, dimmed, until its own fill
  // is done, rather than swapping them for a list that grows a row at a
  // time (DESIGN.md, Kept Data While Reloading). The first load, and "Show
  // more" on rows already shown, fill in place.
  const [kept, setKept] = useState<{ argsKey: string; key: string; rows: SubmissionRow[] } | null>(null);
  const fillDone = status === "Exhausted" || (status === "CanLoadMore" && loadedCount >= target.rows);
  const fresh: SubmissionRow[] | undefined =
    baseArgs === undefined
      ? undefined
      : isSearching
        ? searchResults
        : status === "LoadingFirstPage"
          ? undefined
          : fillDone || kept === null || kept.argsKey === argsKey
            ? paginated.results
            : undefined;
  const freshKey = fresh?.map((row) => row._id).join(",");
  if (fresh !== undefined && freshKey !== undefined && (freshKey !== kept?.key || argsKey !== kept.argsKey)) {
    setKept({ argsKey, key: freshKey, rows: fresh });
  }
  const rows = fresh ?? kept?.rows;
  const reloading = fresh === undefined && kept !== null;
  const filling = !isSearching && (status === "LoadingMore" || (status === "CanLoadMore" && loadedCount < target.rows));
  const canShowMore = !isSearching && status === "CanLoadMore" && loadedCount >= target.rows;

  const [openId, setOpenId] = useState<string | null>(null);

  const filtered = setter !== null || stage !== "all" || isSearching;
  const clearFilters = () => {
    setDraft("");
    onStageChange("all");
    onClearSetter();
  };

  return (
    <div className="@container/subs flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
        <div className="mr-auto min-w-0">
          <h2 className="truncate text-[0.9375rem] font-semibold">{setter ? setter.label : "All setters"}</h2>
          <p className="truncate text-[13px] text-muted-foreground">
            {stage !== "all"
              ? `${dealPositionLabel(stage)} only · `
              : qualified !== undefined
                ? `${formatWholeNumber(qualified)} qualified · `
                : null}
            newest first
          </p>
        </div>
        <div className="flex w-full items-center gap-2 @2xl/subs:w-auto">
          <div className="relative min-w-0 flex-1 @2xl/subs:w-64 @2xl/subs:flex-none">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setDraft("");
              }}
              placeholder="Lead, handle or program"
              aria-label="Search submissions"
              className="h-[30px] pl-8 text-[13px]"
            />
          </div>
          <Select value={stage} onValueChange={(value) => onStageChange(isPosition(value) ? value : "all")}>
            <SelectTrigger aria-label="Filter by deal stage" size="sm" className="h-[30px] w-[7.5rem] shrink-0 text-[13px] @2xl/subs:w-40">
              <SelectValue placeholder="All stages" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All stages</SelectItem>
                {DEAL_POSITIONS.map((position) => (
                  <SelectItem key={position} value={position}>
                    {dealPositionLabel(position)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {rows === undefined || (reloading && rows.length === 0) ? (
          failed ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">Submissions can&apos;t show until the report loads.</p>
          ) : (
            <RowsSkeleton />
          )
        ) : rows.length === 0 ? (
          <SectionEmpty
            title={
              isSearching
                ? `No submissions match “${search}” ${rangePhrase}.`
                : setter
                  ? `${setter.label} has no submissions ${rangePhrase}.`
                  : stage !== "all"
                    ? `No ${dealPositionLabel(stage).toLowerCase()} submissions ${rangePhrase}.`
                    : `No submissions ${rangePhrase}.`
            }
          >
            {filtered ? (
              <button type="button" onClick={clearFilters} className={cn(detailLinkClass, "mt-1 text-[13px]")}>
                Clear filters
              </button>
            ) : (
              "Leads appear here as setters qualify them in Slack."
            )}
          </SectionEmpty>
        ) : (
          <>
            <div
              aria-hidden="true"
              className={cn(
                "hidden min-h-7 items-end gap-3 border-b px-4 pb-1.5 font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase @2xl/subs:grid",
                setter ? COLUMNS_ONE_SETTER : COLUMNS_WITH_SETTER,
              )}
            >
              <span>Qualified</span>
              <span>Lead</span>
              {setter ? null : <span>Setter</span>}
              <span>Program</span>
              <span>Stage</span>
            </div>
            <ul
              aria-label="Submissions"
              aria-busy={reloading}
              className={cn(
                "min-h-0 flex-1 overflow-y-auto overscroll-contain transition-opacity duration-200 motion-reduce:transition-none",
                reloading && "opacity-60",
              )}
            >
              {rows.map((row) => (
                <SubmissionItem
                  key={row._id}
                  row={row}
                  showSetter={setter === null}
                  open={openId === row._id}
                  onToggle={() => setOpenId(openId === row._id ? null : row._id)}
                />
              ))}
            </ul>
            <div className="flex min-h-10 items-center gap-3 border-t px-4 text-[13px] text-muted-foreground">
              <span role="status">
                {isSearching
                  ? `${formatWholeNumber(rows.length)} match${rows.length === 1 ? "" : "es"}${rows.length >= 50 ? ", the first 50" : ""}`
                  : `${formatWholeNumber(rows.length)} shown${status === "Exhausted" ? ", all loaded" : ""}`}
                {filling ? " · loading more…" : null}
              </span>
              {canShowMore ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7"
                  onClick={() => setTarget({ key: argsKey, rows: target.rows + PAGE_SIZE })}
                >
                  Show {PAGE_SIZE} more
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SubmissionItem({
  row,
  showSetter,
  open,
  onToggle,
}: {
  row: SubmissionRow;
  showSetter: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const detailId = useId();
  // The details stay mounted until the close finishes, then leave.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const handle = row.handleSnapshot ? `${row.handleSnapshot} · ${platformLabel(row.platform)}` : platformLabel(row.platform);
  const program = row.bookingProgramName ?? null;
  const setterName = row.slackUser.name ?? row.slackUserLabel ?? "Unknown setter";

  return (
    <li className={cn("border-b last:border-b-0", open && "bg-accent/40")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
        className={cn(
          "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @2xl/subs:min-h-12",
          showSetter ? COLUMNS_WITH_SETTER : COLUMNS_ONE_SETTER,
        )}
      >
        <time
          dateTime={new Date(row.qualifiedAt).toISOString()}
          className="hidden font-condensed text-[15px] font-semibold tabular-nums @2xl/subs:block"
        >
          {eventTime(row.qualifiedAt, now, setting)}
        </time>
        <span className="min-w-0">
          <span className="block truncate font-semibold">{row.leadLabel}</span>
          <span className="block truncate text-[13px] text-muted-foreground">
            <span className="@2xl/subs:hidden">{eventTime(row.qualifiedAt, now, setting)} · </span>
            {handle}
            <span className="@2xl/subs:hidden">
              {showSetter ? ` · ${setterName}` : null}
              {program ? ` · ${program}` : null}
            </span>
          </span>
        </span>
        {showSetter ? (
          <span className="hidden min-w-0 items-center gap-2 @2xl/subs:flex">
            <MemberAvatar identity={row.slackUser} size="sm" />
            <span className="truncate">{setterName}</span>
          </span>
        ) : null}
        <span className={cn("hidden truncate @2xl/subs:block", program === null && "text-muted-foreground")}>
          {program ?? "Unmapped"}
        </span>
        <span className="flex items-center justify-end gap-2 @2xl/subs:contents">
          {row.dealPosition ? (
            <StageWord position={row.dealPosition} className="@2xl/subs:justify-self-start" />
          ) : (
            <span className="font-condensed text-[13px] font-bold tracking-[0.08em] text-muted-foreground uppercase">Not linked</span>
          )}
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-4 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </span>
      </button>
      <div
        id={detailId}
        inert={!open}
        onTransitionEnd={() => {
          if (!open) setMounted(false);
        }}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">{mounted ? <SubmissionDetail row={row} setterName={setterName} /> : null}</div>
      </div>
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-3 py-1">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  );
}

function SubmissionDetail({ row, setterName }: { row: SubmissionRow; setterName: string }) {
  const { setting } = useBusinessDay();
  const dealHref = row.opportunityId
    ? row.leadId
      ? `/workspace/leads-customers/${row.leadId}?opportunityId=${row.opportunityId}`
      : `/workspace/opportunities/${row.opportunityId}`
    : null;
  return (
    <div className="border-t bg-muted/30">
      <dl className="grid gap-x-8 px-4 py-2.5 @2xl/subs:grid-cols-2 @5xl/subs:grid-cols-3">
        <Fact label="Qualified by">{setterName}</Fact>
        <Fact label="Qualified at">
          <span className="font-condensed text-[15px] font-semibold tabular-nums">
            {formatDateTime(row.qualifiedAt, setting.timeZone)}
          </span>
        </Fact>
        <Fact label="Result">{resultWords(row.resultKind)}</Fact>
        <Fact label="Booked program">{row.bookingProgramName ?? <span className="text-muted-foreground">Unmapped</span>}</Fact>
        <Fact label="Sold program">{row.soldProgramName ?? <span className="text-muted-foreground">None yet</span>}</Fact>
        <Fact label="First meeting">
          {row.firstMeetingAt ? (
            <span className="font-condensed text-[15px] font-semibold tabular-nums">
              {formatDateTime(row.firstMeetingAt, setting.timeZone)}
            </span>
          ) : (
            <span className="text-muted-foreground">None booked</span>
          )}
        </Fact>
        <Fact label="DM team">{row.attributionTeamName ?? <span className="text-muted-foreground">None</span>}</Fact>
        <Fact label="DM closer">
          {row.dmCloser?.name ?? (
            <span className="text-muted-foreground">{sentenceCase(row.attributionResolution ?? "none")}</span>
          )}
        </Fact>
        <Fact label="Closer">{row.assignedCloser.name ?? <span className="text-muted-foreground">Unassigned</span>}</Fact>
      </dl>
      {dealHref || row.leadId ? (
        <div className="flex min-h-10 items-center gap-4 border-t px-4 text-[13px]">
          {dealHref ? (
            <Link href={dealHref} className={detailLinkClass}>
              Open deal
            </Link>
          ) : null}
          {row.leadId ? (
            <Link href={`/workspace/leads-customers/${row.leadId}`} className={detailLinkClass}>
              Open person
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div role="status" aria-label="Loading submissions" className="flex flex-col">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex h-12 items-center gap-4 border-b px-4">
          <Skeleton className="hidden h-4 w-16 @2xl/subs:block" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40 max-w-full" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

