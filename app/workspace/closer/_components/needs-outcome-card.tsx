"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { formatDistanceStrict } from "date-fns";
import { SecondOpinionHint } from "@/components/second-opinion/needs-outcome-hint";
import { UnmatchedRecordings } from "@/components/fathom/unmatched-recordings";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { meetingAttendanceDisplay } from "@/lib/status-config";
import { formatAmountMinor } from "@/lib/format-currency";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import {
  NoShowReasonPicker,
  useRecordAttendance,
} from "@/app/workspace/closer/meetings/_components/attendance-question";
import { StageChip } from "@/app/workspace/closer/meetings/_components/stage-tone";
import { firstNameOf } from "@/app/workspace/closer/meetings/_components/meeting-detail-types";
import { readyPreview } from "@/app/workspace/closer/meetings/_components/whop-payment-ask";
import { SectionEmpty } from "./section-state";
import { ScrollMoreHint } from "./scroll-more-hint";
import { useExpandInPlace } from "./use-expand-in-place";
import { formatClock, formatDateTime, formatShortDate } from "./today-time";

type NeedsOutcome = FunctionReturnType<typeof api.closer.dashboard.getMeetingsNeedingOutcome>;
type Row = NeedsOutcome["meetings"][number];
type AttendanceRowData = Extract<Row, { rowKind: "attendance" }>;
type AskRowData = Extract<Row, { rowKind: "whop_ask" }>;
type OutcomeRowData = Extract<Row, { rowKind: "outcome" }>;

const SHOWN = 4;

/**
 * The closer's past calls with no result yet ("Not recorded"), newest first,
 * each with Record outcome on its meeting page. The query also returns
 * today's calls still to come; each joins the list once `now` passes its end.
 * Four show; "Show N more" scrolls the rest inside the same height.
 *
 * Two kinds of row come first: a call whose deal a Whop payment won, which
 * still needs its attendance (Attended / Didn't show), and a Whop payment
 * waiting for the closer's confirmation (Review, on its meeting or task).
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
  const { expanded, toggle, listProps, hintProps } = useExpandInPlace<HTMLUListElement>(
    meetings.length > SHOWN,
  );
  const visible = expanded ? meetings : meetings.slice(0, SHOWN);
  const oldest = meetings.length
    ? meetings.reduce((min, meeting) => (meeting.scheduledAt < min.scheduledAt ? meeting : min))
    : undefined;
  const partial = Boolean(result?.isPartial || result?.attendancePartial);

  return (
    <section aria-labelledby="needs-outcome-title" className="@container rounded-xl border bg-card text-sm text-card-foreground">
      <header className="flex min-h-[46px] items-center gap-2 border-b px-4 py-2">
        <h2 id="needs-outcome-title" className="text-[15px] font-semibold">
          Needs outcome
        </h2>
        {meetings.length > 0 ? (
          <span className="rounded-full bg-warning px-[7px] text-xs leading-[18px] font-semibold text-primary-foreground tabular-nums">
            {meetings.length}
            {partial ? "+" : ""}
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
          <div className="relative">
            <ul {...listProps}>
              {visible.map((meeting) =>
                meeting.rowKind === "attendance" ? (
                  <AttendanceRow
                    key={`attendance:${meeting.meetingId}`}
                    row={meeting}
                    now={now}
                    timeZone={timeZone}
                  />
                ) : meeting.rowKind === "whop_ask" ? (
                  <AskRow key={`ask:${meeting.decisionId}`} row={meeting} now={now} />
                ) : (
                  <OutcomeRow key={meeting.meetingId} meeting={meeting} timeZone={timeZone} />
                ),
              )}
            </ul>
            <ScrollMoreHint {...hintProps} />
          </div>
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
      <UnmatchedRecordings />
    </section>
  );
}

const ROW = "border-t px-4 py-2.5 first:border-t-0";
const OWED_CHIP =
  "shrink-0 rounded-[4px] bg-warning-surface px-1.5 font-condensed text-[11px] leading-[18px] font-bold tracking-[0.1em] text-warning-ink uppercase";

/** An ordinary past call with no result, as before Whop. */
function OutcomeRow({ meeting, timeZone }: { meeting: OutcomeRowData; timeZone: string }) {
  return (
    <li className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 ${ROW}`}>
      <div className="min-w-0">
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 @sm:flex-nowrap">
          <span className="min-w-0 truncate font-semibold">{meeting.leadName}</span>
          <span className={OWED_CHIP}>Not recorded</span>
        </p>
        <p className="truncate text-[13px] text-muted-foreground">
          {[meeting.programName, formatDateTime(meeting.scheduledAt, timeZone)]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <SecondOpinionHint meetingId={meeting.meetingId} />
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
  );
}

/** "Today 2:00 PM", or "Nov 17, 2:00 PM", in the business day's zone. */
function dayTime(at: number, now: number, timeZone: string) {
  return formatShortDate(at, timeZone) === formatShortDate(now, timeZone)
    ? `Today ${formatClock(at, timeZone)}`
    : formatDateTime(at, timeZone);
}

/**
 * A call on a deal a Whop payment won, still owed its attendance. Attended
 * records it in one tap; Didn't show asks for the reason first.
 */
function AttendanceRow({ row, now, timeZone }: { row: AttendanceRowData; now: number; timeZone: string }) {
  const { record, pending } = useRecordAttendance(row.meetingId, firstNameOf(row.leadName));
  const [askingReason, setAskingReason] = useState(false);
  return (
    <li className={`flex flex-col gap-2 ${ROW}`}>
      <div className="min-w-0">
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <Link
            href={`/workspace/closer/meetings/${row.meetingId}`}
            className="min-w-0 truncate font-semibold underline-offset-2 hover:underline focus-visible:underline"
          >
            {row.leadName}
          </Link>
          <span className="min-w-0 truncate text-muted-foreground">· won from Whop</span>
          <StageChip position="won" />
        </p>
        <p className="text-[13px] text-muted-foreground">
          {dayTime(row.scheduledAt, now, timeZone)} call. The payment is recorded; the call still needs its
          attendance.
        </p>
      </div>
      {askingReason ? (
        <NoShowReasonPicker
          pending={pending === "no_show"}
          onCancel={() => setAskingReason(false)}
          onSave={(reason) => {
            void record("no_show", reason);
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="h-8 px-3 font-semibold"
            disabled={pending !== null}
            aria-label={`${row.leadName} attended`}
            onClick={() => void record("held")}
          >
            {pending === "held" ? <Spinner data-icon="inline-start" /> : null}
            <TranslatableText>{pending === "held" ? "Saving…" : "Attended"}</TranslatableText>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-8 px-3"
            disabled={pending !== null}
            aria-label={`${row.leadName} didn't show`}
            onClick={() => setAskingReason(true)}
          >
            Didn&rsquo;t show
          </Button>
        </div>
      )}
    </li>
  );
}

/** "20 minutes ago", or "just now" in the first minute. */
function collectedAgo(at: number, now: number) {
  return now - at < 60_000 ? "just now" : formatDistanceStrict(at, now, { addSuffix: true });
}

/** A Whop payment waiting for the closer: Review opens its meeting or task. */
function AskRow({ row, now }: { row: AskRowData; now: number }) {
  const ask = useQuery(
    api.payments.confirm.getWhopAsk,
    row.meetingId
      ? { target: { kind: "meeting", meetingId: row.meetingId } }
      : row.followUpId
        ? { target: { kind: "reminder", followUpId: row.followUpId } }
        : "skip",
  );
  const preview = readyPreview(ask);
  const amount = preview ? formatAmountMinor(preview.proposal.amountMinor, preview.proposal.currency) : null;
  return (
    <li className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 ${ROW}`}>
      <div className="min-w-0">
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <span className="min-w-0 truncate font-semibold">{row.leadName}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            · Whop payment waiting{amount ? `, ${amount}` : ""}
          </span>
          <span className={OWED_CHIP}>Confirm</span>
        </p>
        <p className="text-[13px] text-muted-foreground">
          Collected {collectedAgo(row.scheduledAt, now)}. After a business day an admin can confirm it from
          Billing.
        </p>
      </div>
      <Button asChild className="h-8 px-3 font-semibold">
        <Link href={row.href} aria-label={`Review the Whop payment for ${row.leadName}`}>
          Review
        </Link>
      </Button>
    </li>
  );
}

/** The calls `getMeetingsNeedingOutcome` returned that have ended by `now`. */
export function endedCalls(result: NeedsOutcome | undefined, now: number) {
  return (result?.meetings ?? []).filter(
    (meeting) => meetingAttendanceDisplay({ ...meeting, status: "scheduled" }, now) === "not_recorded",
  );
}
