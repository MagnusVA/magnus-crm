"use client";

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { meetingAttendanceDisplay } from "@/lib/status-config";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionEmpty } from "./section-state";
import { useExpandInPlace } from "./use-expand-in-place";
import { formatDateTime, formatShortDate } from "./today-time";

type NeedsOutcome = FunctionReturnType<typeof api.closer.dashboard.getMeetingsNeedingOutcome>;

const SHOWN = 4;

/**
 * The closer's past calls with no result yet ("Not recorded"), newest first,
 * each with Record outcome on its meeting page. The query also returns
 * today's calls still to come; each joins the list once `now` passes its end.
 * Four show; "Show N more" scrolls the rest inside the same height.
 */
export function NeedsOutcomeCard({
  result,
  now,
  timeZone,
}: {
  result: NeedsOutcome | undefined;
  now: number;
  timeZone: string;
}) {
  const meetings = endedCalls(result, now);
  const { expanded, toggle, listProps } = useExpandInPlace<HTMLUListElement>(
    meetings.length > SHOWN,
  );
  const visible = expanded ? meetings : meetings.slice(0, SHOWN);
  const oldest = meetings.at(-1);

  return (
    <section aria-labelledby="needs-outcome-title" className="@container rounded-xl border bg-card text-sm text-card-foreground">
      <header className="flex min-h-[46px] items-center gap-2 border-b px-4 py-2">
        <h2 id="needs-outcome-title" className="text-[15px] font-semibold">
          Needs outcome
        </h2>
        {meetings.length > 0 ? (
          <span className="rounded-full bg-warning px-[7px] text-xs leading-[18px] font-semibold text-primary-foreground tabular-nums">
            {meetings.length}
            {result?.isPartial ? "+" : ""}
          </span>
        ) : null}
        {oldest ? (
          <span className="ml-auto text-[13px] text-muted-foreground">
            Since {formatShortDate(oldest.scheduledAt, timeZone)}
          </span>
        ) : null}
      </header>

      {result === undefined ? (
        <div role="status" aria-label="Loading calls that need an outcome">
          {Array.from({ length: 2 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 border-t px-4 py-2.5 first:border-t-0">
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3.5 w-48" />
              </div>
              <Skeleton className="h-8 w-28" />
            </div>
          ))}
        </div>
      ) : meetings.length === 0 ? (
        <SectionEmpty title="Every past call has an outcome." />
      ) : (
        <>
          <ul {...listProps}>
            {visible.map((meeting) => (
              <li
                key={meeting.meetingId}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-t px-4 py-2.5 first:border-t-0"
              >
                <div className="min-w-0">
                  <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 @sm:flex-nowrap">
                    <span className="min-w-0 truncate font-semibold">{meeting.leadName}</span>
                    <span className="shrink-0 rounded-[4px] bg-warning-surface px-1.5 font-condensed text-[11px] leading-[18px] font-bold tracking-[0.1em] text-warning-ink uppercase">
                      Not recorded
                    </span>
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    {[meeting.programName, formatDateTime(meeting.scheduledAt, timeZone)]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Button asChild className="h-8 px-3 font-semibold">
                  <Link
                    href={`/workspace/closer/meetings/${meeting.meetingId}`}
                    aria-label={`Record outcome for ${meeting.leadName}`}
                  >
                    Record outcome
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
          {meetings.length > SHOWN ? (
            <div className="flex min-h-[38px] items-center border-t px-4">
              <Button
                variant="link"
                size="sm"
                className="h-7 px-0 text-[13px] text-foreground"
                aria-expanded={expanded}
                onClick={toggle}
              >
                {expanded ? "Show fewer" : `Show ${meetings.length - SHOWN} more`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The calls `getMeetingsNeedingOutcome` returned that have ended by `now`. */
export function endedCalls(result: NeedsOutcome | undefined, now: number) {
  return (result?.meetings ?? []).filter(
    (meeting) => meetingAttendanceDisplay({ ...meeting, status: "scheduled" }, now) === "not_recorded",
  );
}
