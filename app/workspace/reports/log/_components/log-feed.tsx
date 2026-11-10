"use client";

import Link from "next/link";
import { format } from "date-fns";
import type { LogEntry } from "@/convex/reports/log";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { PageRows, ReportPager, type PagerState } from "../../_components/report-paging";
import { LABEL, ReportCard, StatusWord, type StatusTone } from "../../_components/report-ui";
import { entityHref, entityWord, personHref, sentenceCase, statusWords } from "./log-shape";

// The Log's feed (§12): the audit trail newest first, a page of 25 at a time,
// one ruled row per event, WHEN · WHO · WHAT · RECORD · STATUS from @3xl/feed and two lines
// narrower. A record opens its page when it has one.

const COLUMNS =
  "@3xl/feed:grid @3xl/feed:grid-cols-[7.5rem_minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_7rem] @3xl/feed:items-center @3xl/feed:gap-3";

const FAILED = new Set(["lost", "no_show", "churned", "expired", "disputed", "voided", "deactivated", "blocked", "unpaid"]);
const OWED = new Set(["paused", "pending", "qualified_pending", "reschedule_link_sent", "not_recorded", "past_due"]);
const LIVE = new Set(["scheduled", "booked", "qualified", "call_held", "follow_up", "active", "won", "payment_received", "in_progress"]);

function toneFor(status: string): StatusTone {
  if (FAILED.has(status)) return "failed";
  if (OWED.has(status)) return "owed";
  if (LIVE.has(status)) return "live";
  return "done";
}

function RecordLinks({ entry }: { entry: LogEntry }) {
  const record = entityHref(entry);
  const person = personHref(entry);
  return (
    <>
      {record ? (
        <Link href={record} className={detailLinkClass}>
          {entityWord(entry.entityType)}
        </Link>
      ) : (
        entityWord(entry.entityType)
      )}
      {person ? (
        <>
          {" · "}
          <Link href={person} className={detailLinkClass}>
            Person
          </Link>
        </>
      ) : null}
    </>
  );
}

function LogRow({ entry, oneDay }: { entry: LogEntry; oneDay: boolean }) {
  const when = format(entry.occurredAt, oneDay ? "h:mm a" : "MMM d · h:mm a");
  const iso = new Date(entry.occurredAt).toISOString();
  const what = sentenceCase(entry.label);
  const status = entry.toStatus ? (
    <StatusWord tone={toneFor(entry.toStatus)}>{statusWords(entry.toStatus)}</StatusWord>
  ) : null;
  return (
    <li className="border-b transition-colors last:border-b-0 hover:bg-muted/60">
      <div className={cn("flex flex-col gap-0.5 px-4 py-2 @3xl/feed:h-11 @3xl/feed:py-0", COLUMNS)}>
        <time dateTime={iso} className="hidden truncate font-condensed text-[15px] font-semibold tabular-nums @3xl/feed:block">
          {when}
        </time>
        <div className="flex min-w-0 items-center gap-3">
          <p className={cn("min-w-0 flex-1 truncate font-semibold", !entry.actorName && "text-muted-foreground")}>
            {entry.actorName ?? "System"}
            <span className="font-normal text-foreground @3xl/feed:hidden"> · {what}</span>
          </p>
          <span className="@3xl/feed:hidden">{status}</span>
        </div>
        <p className="truncate text-[13px] text-muted-foreground @3xl/feed:hidden">
          <time dateTime={iso} className="font-condensed text-[14px] tabular-nums">
            {when}
          </time>
          {" · "}
          <RecordLinks entry={entry} />
        </p>
        <p className="hidden truncate @3xl/feed:block" title={what}>
          {what}
        </p>
        <p className="hidden truncate text-[13px] @3xl/feed:block">
          <RecordLinks entry={entry} />
        </p>
        <span className="hidden truncate @3xl/feed:block">{status}</span>
      </div>
    </li>
  );
}

export function LogFeed({
  rows,
  pager,
  loadingMore,
  onLookFurther,
  reloading,
  oneDay,
  phrase,
  onClearFilters,
}: {
  /** The page of events shown; undefined until the first page arrives. */
  rows: LogEntry[] | undefined;
  pager: PagerState;
  loadingMore: boolean;
  /** Reads further back when the events read so far hold no match. */
  onLookFurther: () => void;
  reloading: boolean;
  oneDay: boolean;
  phrase: string;
  /** Set while a filter is applied. */
  onClearFilters?: () => void;
}) {
  const count = rows?.length ?? 0;
  return (
    <ReportCard
      title="Events"
      meta="Newest first"
      container="@container/feed"
      reloading={reloading}
      footer={rows !== undefined && count > 0 ? <ReportPager pager={pager} noun="events" /> : null}
    >
      {rows === undefined ? (
        <div role="status" aria-label="Loading the log">
          {Array.from({ length: 10 }, (_, index) => (
            <div key={index} className="flex h-11 items-center gap-4 border-b px-4 last:border-b-0">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3.5 flex-1" />
            </div>
          ))}
        </div>
      ) : count === 0 && !pager.hasNext ? (
        <SectionEmpty title={onClearFilters ? `No events match these filters ${phrase}.` : `No events ${phrase}.`}>
          {onClearFilters ? (
            <button type="button" onClick={onClearFilters} className={cn(detailLinkClass, "text-[13px]")}>
              Clear filters
            </button>
          ) : (
            "Every change to a call, deal, payment, person or reminder shows here."
          )}
        </SectionEmpty>
      ) : count === 0 ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm text-muted-foreground">
          <p>No matches in the events read so far. Matches may be further back.</p>
          <Button variant="outline" size="sm" onClick={onLookFurther} disabled={loadingMore}>
            {loadingMore ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
            {loadingMore ? "Reading…" : "Look further back"}
          </Button>
        </div>
      ) : (
        <>
          <div className={cn("hidden min-h-7 items-end border-b px-4 pb-1.5", COLUMNS, LABEL)}>
            <span>
              <HelpTip tip="Times follow your browser's time zone.">When</HelpTip>
            </span>
            <span>Who</span>
            <span>What</span>
            <span>Record</span>
            <span>Status</span>
          </div>
          <PageRows pager={pager}>
            <ul aria-label="Events">
              {rows.map((entry) => (
                <LogRow key={entry._id} entry={entry} oneDay={oneDay} />
              ))}
            </ul>
          </PageRows>
        </>
      )}
    </ReportCard>
  );
}
