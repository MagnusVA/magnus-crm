"use client";

import { useId, useMemo, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DetailCard, DetailCardFooter } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useBusinessDay } from "@/hooks/use-business-day";
import { addBusinessDays, businessDayStart, type BusinessDaySetting } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { formatCount, headClass } from "./lead-gen-format";
import type { LeadGenFilters } from "./lead-gen-admin-page-client";
import { VoidSubmissionDialog } from "./void-submission-dialog";

// Every capture in the range, voided ones included: the audit view, folded
// at the foot of the page until it's wanted. Opening it loads 25 rows.

const PAGE_SIZE = 25;

type RawSubmissionRow = {
  submissionId: Id<"leadGenSubmissions">;
  prospectId: Id<"leadGenProspects">;
  submittedAt: number;
  createdAt: number;
  workerId: Id<"leadGenWorkers">;
  workerDisplayName: string | null;
  workerEmail: string | null;
  teamId: Id<"attributionTeams"> | null;
  teamName: string | null;
  source: "instagram" | "meta_business";
  normalizedHandle: string | null;
  rawHandle: string | null;
  profileUrl: string | null;
  originKind: string;
  originValue: string | null;
  originRankable: boolean;
  clientSubmissionKey: string | null;
  voidedAt: number | null;
  voidReason: string | null;
};

function buildRawQueryArgs(filters: LeadGenFilters, setting: BusinessDaySetting) {
  const startTimestamp = businessDayStart(filters.startDayKey, setting);
  const nextEndDayKey = addBusinessDays(filters.endDayKey, 1);
  const nextEndTimestamp = nextEndDayKey ? businessDayStart(nextEndDayKey, setting) : null;
  if (startTimestamp == null || nextEndTimestamp == null || nextEndTimestamp <= startTimestamp) {
    return "skip" as const;
  }
  return {
    startTimestamp,
    endTimestamp: nextEndTimestamp - 1,
    ...(filters.source ? { source: filters.source } : {}),
  };
}

/** Day and time in the tenant's time zone; the year only outside this year. */
function useWhen(timeZone: string) {
  return useMemo(() => {
    const thisYear = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(new Date());
    const year = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone });
    const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone });
    const dayYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
    return {
      day: (at: number) => (year.format(at) === thisYear ? day : dayYear).format(at),
      time: (at: number) => time.format(at),
    };
  }, [timeZone]);
}

function prospectLabel(row: RawSubmissionRow) {
  if (row.normalizedHandle) return `@${row.normalizedHandle}`;
  return row.rawHandle ?? "Prospect";
}

function sourceWord(source: RawSubmissionRow["source"]) {
  return source === "meta_business" ? "Meta Business" : "Instagram";
}

function originWord(originKind: string) {
  if (originKind === "source_only") return "No origin";
  const words = originKind.split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function readableOrigin(originValue: string) {
  try {
    const url = new URL(originValue);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname}`;
  } catch {
    return originValue;
  }
}

const linkClass =
  "inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm underline decoration-foreground/30 underline-offset-[3px] outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring";

function Prospect({ row }: { row: RawSubmissionRow }) {
  const label = prospectLabel(row);
  return (
    <div className="min-w-0" title={row.prospectId}>
      {row.profileUrl ? (
        <a className={cn(linkClass, "font-medium")} href={row.profileUrl} rel="noreferrer" target="_blank">
          <span className="truncate">{label}</span>
          <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <p className="truncate font-medium">{label}</p>
      )}
      {row.rawHandle && row.rawHandle !== label ? (
        <p className="truncate text-[13px] text-muted-foreground">{row.rawHandle}</p>
      ) : null}
    </div>
  );
}

function Origin({ row }: { row: RawSubmissionRow }) {
  const external = typeof row.originValue === "string" && /^https?:\/\//.test(row.originValue);
  return (
    <div className="min-w-0">
      {row.originValue ? (
        external ? (
          <a className={linkClass} href={row.originValue} rel="noreferrer" target="_blank" title={row.originValue}>
            <span className="truncate">{readableOrigin(row.originValue)}</span>
            <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <p className="truncate">{row.originValue}</p>
        )
      ) : null}
      <p className="truncate text-[13px] text-muted-foreground">
        {sourceWord(row.source)} · {originWord(row.originKind)}
        {row.clientSubmissionKey ? <span className="hidden @6xl/raw:inline"> · Key {row.clientSubmissionKey}</span> : null}
      </p>
    </div>
  );
}

function Status({ row, when }: { row: RawSubmissionRow; when: ReturnType<typeof useWhen> }) {
  if (!row.voidedAt) {
    return (
      <span className="font-condensed text-[13px] font-bold tracking-[0.08em] text-muted-foreground uppercase">Active</span>
    );
  }
  return (
    <div className="min-w-0">
      <p className="font-condensed text-[13px] font-bold tracking-[0.08em] text-danger-ink uppercase">
        Voided <span className="font-semibold tracking-[0.02em] normal-case">{when.day(row.voidedAt)}, {when.time(row.voidedAt)}</span>
      </p>
      {row.voidReason ? (
        <p className="truncate text-[13px] text-muted-foreground" title={row.voidReason}>
          {row.voidReason}
        </p>
      ) : null}
    </div>
  );
}

function VoidAction({ row }: { row: RawSubmissionRow }) {
  if (row.voidedAt) return <span className="sr-only">Already voided</span>;
  return <VoidSubmissionDialog compactTrigger prospectLabel={prospectLabel(row)} submissionId={row.submissionId} />;
}

function Rows({ rows, when }: { rows: RawSubmissionRow[]; when: ReturnType<typeof useWhen> }) {
  return (
    <>
      <table className="hidden w-full table-fixed border-collapse @4xl/raw:table">
        <caption className="sr-only">Raw submissions</caption>
        <colgroup>
          <col className="w-28" />
          <col className="w-[19%]" />
          <col className="w-[19%]" />
          <col />
          <col className="w-[20%]" />
          <col className="w-14" />
        </colgroup>
        <thead>
          <tr className="border-b">
            <th scope="col" className={headClass("left")}>Submitted</th>
            <th scope="col" className={cn(headClass(), "text-left")}>Prospect</th>
            <th scope="col" className={cn(headClass(), "text-left")}>Specialist</th>
            <th scope="col" className={cn(headClass(), "text-left")}>Origin</th>
            <th scope="col" className={cn(headClass(), "text-left")}>Status</th>
            <th scope="col" className={cn(headClass(), "pr-4")}>
              <span className="sr-only">Void</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.submissionId} className={cn("border-b last:border-b-0", row.voidedAt && "bg-muted/30")}>
              <td className="py-2 pr-2.5 pl-4 align-top">
                <time dateTime={new Date(row.submittedAt).toISOString()} className="block leading-tight">
                  <span className="block font-condensed text-[15px] font-semibold tabular-nums">{when.day(row.submittedAt)}</span>
                  <span className="text-[13px] text-muted-foreground tabular-nums">{when.time(row.submittedAt)}</span>
                </time>
              </td>
              <td className="px-2.5 py-2 align-top">
                <Prospect row={row} />
              </td>
              <td className="px-2.5 py-2 align-top" title={row.workerEmail ?? undefined}>
                <p className="truncate font-medium">{row.workerDisplayName ?? row.workerEmail ?? "Specialist"}</p>
                <p className="truncate text-[13px] text-muted-foreground">{row.teamName ?? "No team"}</p>
              </td>
              <td className="px-2.5 py-2 align-top">
                <Origin row={row} />
              </td>
              <td className="px-2.5 py-2 align-top">
                <Status row={row} when={when} />
              </td>
              <td className="py-1.5 pr-4 pl-2.5 text-right align-top">
                <VoidAction row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul aria-label="Raw submissions" className="flex flex-col @4xl/raw:hidden">
        {rows.map((row) => (
          <li key={row.submissionId} className={cn("flex items-start gap-3 border-b px-4 py-2.5 last:border-b-0", row.voidedAt && "bg-muted/30")}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <Prospect row={row} />
                <time dateTime={new Date(row.submittedAt).toISOString()} className="shrink-0 font-condensed text-[14px] font-semibold tabular-nums">
                  {when.day(row.submittedAt)} · {when.time(row.submittedAt)}
                </time>
              </div>
              <p className="truncate text-[13px] text-muted-foreground">
                {row.workerDisplayName ?? row.workerEmail ?? "Specialist"} · {row.teamName ?? "No team"}
              </p>
              <Origin row={row} />
              <Status row={row} when={when} />
            </div>
            <VoidAction row={row} />
          </li>
        ))}
      </ul>
    </>
  );
}

export function RawSubmissionsCard({ filters }: { filters: LeadGenFilters }) {
  const { setting } = useBusinessDay("lead-gen");
  const when = useWhen(setting.timeZone);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const queryArgs = useMemo(() => buildRawQueryArgs(filters, setting), [filters, setting]);
  const validRange = queryArgs !== "skip";
  const { results, status, loadMore } = usePaginatedQuery(
    api.leadGen.exports.listRawSubmissionExportPage,
    open ? queryArgs : "skip",
    { initialNumItems: PAGE_SIZE },
  );
  const rows = results as RawSubmissionRow[];
  const firstLoad = open && validRange && status === "LoadingFirstPage";
  const loadingMore = status === "LoadingMore";

  return (
    <DetailCard
      title="Raw submissions"
      meta={
        <>
          <span className="hidden @xl:inline">
            {open && !firstLoad && validRange
              ? `${formatCount(rows.length)} shown${status === "Exhausted" ? ", all loaded" : ""}`
              : "Every capture in this range, voided ones included"}
          </span>
          <Button
            size="xs"
            variant="outline"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Hide" : "Show"}
            <ChevronDownIcon
              data-icon="inline-end"
              aria-hidden="true"
              className={cn("transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")}
            />
          </Button>
        </>
      }
      className={cn("@container/raw min-w-0", !open && "[&>div:first-child]:border-b-0")}
    >
      <div id={panelId} hidden={!open}>
        {!open ? null : !validRange ? (
          <SectionEmpty title="Choose a range that starts on or before its last day." />
        ) : firstLoad ? (
          <div role="status" aria-label="Loading raw submissions" className="flex flex-col">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="flex h-[58px] items-center gap-4 border-b px-4 last:border-b-0">
                <Skeleton className="h-8 w-14" />
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3.5 flex-1" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <SectionEmpty title="No submissions in this range." />
        ) : (
          <>
            <Rows rows={rows} when={when} />
            <DetailCardFooter>
              <span className="text-[13px] font-normal">
                {status === "Exhausted"
                  ? `All ${formatCount(rows.length)} shown`
                  : `Showing ${formatCount(rows.length)}`}
              </span>
              {status === "CanLoadMore" || loadingMore ? (
                <Button size="xs" variant="outline" disabled={loadingMore} onClick={() => loadMore(PAGE_SIZE)}>
                  {loadingMore ? <Spinner data-icon="inline-start" /> : null}
                  {loadingMore ? "Loading…" : "Show more"}
                </Button>
              ) : null}
            </DetailCardFooter>
          </>
        )}
      </div>
    </DetailCard>
  );
}
