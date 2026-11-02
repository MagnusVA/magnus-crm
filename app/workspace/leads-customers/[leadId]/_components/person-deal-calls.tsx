"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { Id } from "@/convex/_generated/dataModel";
import { businessDateForInstant } from "@/lib/businessDay";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { formatBusinessDate, formatClock } from "@/app/workspace/closer/_components/today-time";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { ROW_LINK } from "@/app/workspace/closer/pipeline/_components/deal-cells";
import { useEntityDetail, type EntityDetailMeeting } from "./entity-detail-context";
import { meetingDetailHref } from "./meeting-link-utils";
import { useOpportunitySheet } from "./opportunity-sheet-context";

/** How many calls a deal card lists before "All N calls". */
const SHOWN_CALLS = 3;

const COLUMNS = "@xl/calls:grid-cols-[9.5rem_8.5rem_4rem_minmax(0,1fr)_auto]";

type Attendance = { word: string; ink: string; owed: boolean };

/** The call's attendance as one condensed word in its ink; a past call still scheduled is owed. */
export function attendanceOf(
  meeting: Pick<EntityDetailMeeting, "status" | "scheduledAt" | "durationMinutes">,
  now: number,
): Attendance {
  switch (meeting.status) {
    case "held":
      return { word: "Held", ink: "text-stage-held-ink", owed: false };
    case "no_show":
      return { word: "No-show", ink: "text-danger-ink", owed: false };
    case "canceled":
      return { word: "Canceled", ink: "text-muted-foreground", owed: false };
    case "scheduled":
      return meeting.scheduledAt + meeting.durationMinutes * 60_000 <= now
        ? { word: "Not recorded", ink: "text-warning-ink", owed: true }
        : { word: "Scheduled", ink: "text-stage-booked-ink", owed: false };
  }
}

/** The calls on a deal and which of them, if any, carries the lime "Record outcome". */
export function useDealCalls(opportunityId: Id<"opportunities">) {
  const { meetings } = useEntityDetail();
  const now = useNow();
  // The page's meetings come newest first.
  const calls = meetings.filter((meeting) => meeting.opportunityId === opportunityId);
  const shown = calls.slice(0, SHOWN_CALLS);
  // The newest call with nothing recorded that the viewer can record is the
  // deal's next action; at most one lime button per card.
  const owed =
    shown.find(
      (meeting) => attendanceOf(meeting, now).owed && meeting.permissions.canOpenMeeting,
    ) ?? null;
  return { calls, shown, owed, now };
}

/**
 * The deal's calls under its track: when, attendance, length and the
 * latest note, newest first, three at most, then "All N calls" (the deal
 * modal). A call with nothing recorded carries the lime "Record outcome".
 * In a narrow card each call folds onto two lines.
 */
export function DealCalls({
  opportunityId,
  canOpenDeal,
}: {
  opportunityId: Id<"opportunities">;
  canOpenDeal: boolean;
}) {
  const { comments, viewer } = useEntityDetail();
  const { setting } = useBusinessDay();
  const {
    actions: { openOpportunity },
  } = useOpportunitySheet();
  const { calls, shown, owed, now } = useDealCalls(opportunityId);
  if (shown.length === 0) return null;

  const latestNote = new Map<string, string>();
  for (const comment of [...comments].sort((a, b) => b.createdAt - a.createdAt)) {
    if (!latestNote.has(comment.meetingId)) latestNote.set(comment.meetingId, comment.content);
  }

  return (
    <div className="@container/calls border-t">
      <div
        aria-hidden
        className={cn(
          "hidden h-7 items-center gap-x-3.5 border-b px-4 font-condensed text-[0.6875rem] font-semibold tracking-[0.14em] text-muted-foreground uppercase @xl/calls:grid",
          COLUMNS,
        )}
      >
        <span>Call</span>
        <span>Attendance</span>
        <span>Length</span>
        <span>Note</span>
        <span />
      </div>
      <ul className="divide-y" aria-label="Calls on this deal">
        {shown.map((meeting) => {
          const attendance = attendanceOf(meeting, now);
          const href = meeting.permissions.canOpenMeeting
            ? meetingDetailHref({ meetingId: meeting._id, viewerRole: viewer.role })
            : null;
          const dateKey = businessDateForInstant(meeting.scheduledAt, setting);
          // "Thu Jun 18", as the sketch and the board write a day.
          const day = `${formatBusinessDate(dateKey, { weekday: "short" })} ${formatBusinessDate(dateKey, { month: "short", day: "numeric" })}`;
          const note = latestNote.get(meeting._id) ?? null;
          const isOwed = owed?._id === meeting._id;
          return (
            <li
              key={meeting._id}
              className={cn(
                "relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-0.5 px-4 py-2 hover:bg-muted/60 @xl/calls:min-h-12 @xl/calls:py-1.5",
                COLUMNS,
              )}
            >
              <p className="min-w-0 font-condensed text-[15px] font-semibold tracking-[0.02em] tabular-nums" suppressHydrationWarning>
                {href ? (
                  <Link href={href} className={ROW_LINK} aria-label={`Open the call on ${day}`}>
                    {day}
                  </Link>
                ) : (
                  day
                )}
                <span className="ml-1.5 text-[0.8125rem] font-medium text-muted-foreground">
                  {formatClock(meeting.scheduledAt, setting.timeZone)}
                </span>
              </p>
              <p
                className={cn(
                  "flex items-center gap-1.5 justify-self-end font-condensed text-[13px] font-bold tracking-[0.08em] whitespace-nowrap uppercase @xl/calls:justify-self-start",
                  attendance.ink,
                )}
                suppressHydrationWarning
              >
                {attendance.owed ? <span aria-hidden className="size-1.5 rounded-full bg-warning" /> : null}
                {attendance.word}
              </p>
              <p className="hidden font-condensed text-[15px] font-semibold tabular-nums @xl/calls:block">
                {meeting.durationMinutes} min
              </p>
              <p className="col-span-2 min-w-0 truncate text-[0.8125rem] @xl/calls:col-span-1" title={note ?? undefined}>
                <span className="font-condensed font-semibold tabular-nums @xl/calls:hidden">
                  {meeting.durationMinutes} min ·{" "}
                </span>
                {note ? (
                  <span translate="no">{note}</span>
                ) : (
                  <span className="text-muted-foreground">No note yet</span>
                )}
              </p>
              <div className="relative z-10 col-span-2 @xl/calls:col-span-1">
                {isOwed && href ? (
                  <Button asChild size="sm" className="mt-1.5 @xl/calls:mt-0">
                    <Link href={href}>Record outcome</Link>
                  </Button>
                ) : attendance.owed && href ? (
                  <Link href={href} className={detailLinkClass}>
                    Record outcome
                  </Link>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {calls.length > SHOWN_CALLS && canOpenDeal ? (
        <div className="flex h-8 items-center border-t px-4 text-[0.8125rem]">
          <button type="button" className={detailLinkClass} onClick={() => openOpportunity(opportunityId)}>
            All {calls.length} calls
          </button>
        </div>
      ) : null}
    </div>
  );
}
