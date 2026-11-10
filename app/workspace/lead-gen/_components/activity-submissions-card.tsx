"use client";

import dynamic from "next/dynamic";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { CARD, LABEL } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";
import {
  dayAndTime,
  timeOfDay,
  originWords,
  ProspectHandle,
  ROW_TIME,
  sourceName,
  STATUS_WORD,
  whatWord,
  type ActivityRow,
} from "./setter-ui";

// My activity's list: one ruled 36px line per capture or worked respark,
// newest first. The card is the container the rows fold by: from @3xl/subs
// one line (WHEN · PROSPECT · WHAT · SOURCE · ORIGIN); narrower, two lines
// (the handle and WHAT, then when · source · origin in slate).

const CaptureFlagDialog = dynamic(() => import("./capture-flag-dialog").then(mod => mod.CaptureFlagDialog));

export const ACTIVITY_PAGE_SIZE = 25;

const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 @3xl/subs:grid-cols-[8.75rem_minmax(0,1.15fr)_6.5rem_7.5rem_minmax(0,1.25fr)]";

export function ActivitySubmissionsCard({
  rows,
  reloading,
  canLoadMore,
  loadingMore,
  onLoadMore,
  emptyTitle,
  timeZone,
  singleDay,
  dates,
}: {
  /** Undefined until the first page arrives. */
  rows: ActivityRow[] | undefined;
  reloading: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  emptyTitle: string;
  timeZone: string;
  /** The range is one day, which the band names, so rows show the time only. */
  singleDay: boolean;
  /** The rows' days, when they differ from the band's. */
  dates: string | null;
}) {
  return (
    <section aria-labelledby="activity-submissions-title" className={cn(CARD, "@container/subs")}>
      <ActivityCardHead dates={dates} />
      {rows === undefined || (reloading && rows.length === 0) ? (
        <ActivityRowsSkeleton />
      ) : rows.length === 0 ? (
        <SectionEmpty title={emptyTitle} />
      ) : (
        <div
          aria-busy={reloading}
          className={cn("transition-opacity duration-200 motion-reduce:transition-none", reloading && "opacity-60")}
        >
          <ActivityHeads />
          <ul aria-label="Submissions">
            {rows.map((row) => (
              <ActivityRowItem key={row._id} row={row} timeZone={timeZone} singleDay={singleDay} />
            ))}
          </ul>
        </div>
      )}
      {rows !== undefined && !reloading && (canLoadMore || loadingMore) ? (
        <div className="flex min-h-10 items-center border-t border-border px-4 py-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto h-7"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? "Loading…" : `Show ${ACTIVITY_PAGE_SIZE} more`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ActivityCardHead({ dates = null }: { dates?: string | null }) {
  return (
    <div className="flex min-h-11 items-center gap-2.5 border-b border-border px-4 py-2">
      <h2 id="activity-submissions-title" className="text-[15px] font-semibold">
        Submissions
      </h2>
      <span className="text-[13px] text-muted-foreground">{dates ? `${dates} · newest first` : "newest first"}</span>
    </div>
  );
}

function ActivityHeads() {
  return (
    <div className={cn(COLUMNS, "hidden min-h-7 border-b border-border px-4 pt-2 pb-1.5 @3xl/subs:grid", LABEL)}>
      <span>When</span>
      <span>Prospect</span>
      <span>What</span>
      <span>Source</span>
      <span>Origin</span>
    </div>
  );
}

function ActivityRowItem({ row, timeZone, singleDay }: { row: ActivityRow; timeZone: string; singleDay: boolean }) {
  const when = singleDay ? timeOfDay(row.submittedAt, timeZone) : dayAndTime(row.submittedAt, timeZone);
  const { role } = useRole();
  const what = row.isVoided ? { word: "Voided", ink: "text-danger-ink" }
    : row.flag ? { word: row.flag.state === "open" ? "Flagged" : row.flag.state === "dismissed" ? "Dismissed" : "Voided", ink: "text-muted-foreground" }
    : whatWord(row.type);
  const source = sourceName(row.source);
  const origin = originWords(row);
  const originTitle = origin.href ?? origin.text;

  return (
    <li
      className={cn(
        COLUMNS,
        "min-h-[52px] border-b border-border px-4 py-2 text-sm last:border-b-0 @3xl/subs:min-h-9 @3xl/subs:py-1",
      )}
    >
      <time dateTime={new Date(row.submittedAt).toISOString()} className={cn(ROW_TIME, "hidden @3xl/subs:block")}>
        {when}
      </time>
      <div className="min-w-0">
        <ProspectHandle handle={row.prospect?.normalizedHandle} className="text-sm" />
        <p className="truncate text-[13px] leading-[18px] text-muted-foreground @3xl/subs:hidden">
          <span className="font-condensed text-[14px] font-semibold tabular-nums">{when}</span> · {source}
          {origin.empty ? null : (
            <>
              {" · "}
              <span title={originTitle}>{origin.text}</span>
            </>
          )}
        </p>
      </div>
      <span className={cn(STATUS_WORD, what.ink, "justify-self-end @3xl/subs:justify-self-start")}>{what.word}</span>
      <span className="hidden truncate @3xl/subs:block">{source}</span>
      <span className="hidden min-w-0 @3xl/subs:block">
        {origin.href ? (
          <a
            href={origin.href}
            target="_blank"
            rel="noreferrer"
            title={originTitle}
            className="block truncate rounded-sm underline-offset-[3px] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {origin.text}
          </a>
        ) : (
          <span title={originTitle} className={cn("block truncate", origin.empty && "text-muted-foreground")}>
            {origin.text}
          </span>
        )}
      </span>
      {row.submissionId ? (
        <div className="col-span-full flex min-w-0 flex-wrap items-start justify-end gap-x-3 gap-y-2">
          {row.flag ? (
            <details className="mr-auto min-w-0 flex-1 text-[13px] text-muted-foreground">
              <summary className="min-h-6 w-fit cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">Flag details</summary>
              <p className="whitespace-pre-wrap break-words">Your reason: {row.flag.reason}</p>
              {row.flag.dismissal?.note ? <p className="whitespace-pre-wrap break-words">Admin note: {row.flag.dismissal.note.text}</p> : null}
              {row.flag.dismissal?.withheld ? <p>The admin note could not be shown safely.</p> : null}
            </details>
          ) : null}
          {/* Row actions wrap here so the contact date action can join them. */}
          {role === "lead_generator" && !row.isVoided && !row.flag ? (
            <CaptureFlagDialog kind="flag" submissionId={row.submissionId} prospectLabel={row.prospect?.normalizedHandle ? `@${row.prospect.normalizedHandle}` : "this person"} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Rows at their real height (36px, 52px two-line below @3xl/subs) while the first page loads. */
export function ActivityRowsSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading submissions">
      <div className="hidden min-h-7 items-end gap-4 border-b border-border px-4 pb-1.5 @3xl/subs:flex">
        <Skeleton className="h-2.5 w-10" />
        <Skeleton className="ml-24 h-2.5 w-16" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={cn(COLUMNS, "min-h-[52px] border-b border-border px-4 py-2 last:border-b-0 @3xl/subs:min-h-9 @3xl/subs:py-1")}
        >
          <Skeleton className="hidden h-4 w-28 @3xl/subs:block" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-36 max-w-full" />
            <Skeleton className="h-3 w-56 max-w-full @3xl/subs:hidden" />
          </div>
          <Skeleton className="h-3 w-16" />
          <Skeleton className="hidden h-3.5 w-20 @3xl/subs:block" />
          <Skeleton className="hidden h-3.5 w-32 @3xl/subs:block" />
        </div>
      ))}
    </div>
  );
}

/** The card as the page skeleton draws it. */
export function ActivitySubmissionsCardSkeleton() {
  return (
    <div className={cn(CARD, "@container/subs")}>
      <ActivityCardHead />
      <ActivityRowsSkeleton />
    </div>
  );
}
