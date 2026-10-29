"use client";

import { format, formatDistanceStrict } from "date-fns";
import { CheckIcon, CopyIcon, VideoIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** "Boarding" opens this long before the call, as the outcome window does. */
const BOARDING_LEAD_MS = 15 * 60_000;

type StripTone = "action" | "due" | "neutral" | "missed";

type CallStatus = {
  word: string;
  detail: string;
  tone: StripTone;
};

const TONE_WORD_CLASS: Record<StripTone, string> = {
  action: "text-primary",
  due: "text-warning",
  neutral: "text-board-foreground",
  missed: "text-board-foreground",
};

const TONE_DOT_CLASS: Record<StripTone, string> = {
  action: "bg-primary",
  due: "bg-warning",
  neutral: "bg-stage-held",
  missed: "bg-stage-lost",
};

/**
 * One status word for the call, read like a departures board. It reads the
 * meeting's stored attendance; "Not recorded" is the display rule for a
 * scheduled call that has ended (CONTEXT.md, "Meeting").
 */
export function callStatus(meeting: Doc<"meetings">, now: number): CallStatus {
  const start = meeting.scheduledAt;
  const end = start + meeting.durationMinutes * 60_000;
  const ago = (at: number) => `${formatDistanceStrict(at, now)} ago`;

  switch (meeting.status) {
    case "held":
      return {
        word: "Held",
        detail: meeting.heldMarkedAt
          ? `Recorded ${ago(meeting.heldMarkedAt)}`
          : `Call on ${format(start, "MMM d")}`,
        tone: "neutral",
      };
    case "no_show":
      return {
        word: "No-show",
        detail: meeting.noShowMarkedAt
          ? `Recorded ${ago(meeting.noShowMarkedAt)}`
          : `Call on ${format(start, "MMM d")}`,
        tone: "missed",
      };
    case "canceled":
      return {
        word: "Canceled",
        detail: meeting.canceledAt
          ? `Canceled ${ago(meeting.canceledAt)}`
          : `Call on ${format(start, "MMM d")}`,
        tone: "missed",
      };
    case "scheduled":
      if (now >= end) {
        return { word: "Not recorded", detail: `Call ended ${ago(end)}`, tone: "due" };
      }
      if (now >= start) {
        return {
          word: "In progress",
          detail: `Ends in ${formatDistanceStrict(end, now)}`,
          tone: "action",
        };
      }
      if (now >= start - BOARDING_LEAD_MS) {
        return {
          word: "Boarding",
          detail: `Starts in ${formatDistanceStrict(start, now)}`,
          tone: "action",
        };
      }
      return {
        word: "On time",
        detail: `Starts in ${formatDistanceStrict(start, now)}`,
        tone: "neutral",
      };
  }
}

/** "Open Zoom", "Join Meet", or "Join call", from the link's provider. */
function joinLabel(meeting: Doc<"meetings">, url: string): string {
  const where = `${meeting.meetingLocationType ?? ""} ${url}`.toLowerCase();
  if (where.includes("zoom")) return "Open Zoom";
  if (where.includes("google") || where.includes("meet.")) return "Join Meet";
  if (where.includes("teams")) return "Join Teams";
  return "Join call";
}

type CallStripProps = {
  meeting: Doc<"meetings">;
  now: number;
  leadName: string;
  /** How the call was booked, such as "Booked via Calendly · Intro call". */
  bookedVia: string;
  programName: string | null;
  /** The amount paid on the deal, once it is won. */
  programValue: string | null;
};

const COLUMNS =
  "@4xl:grid-cols-[9.5rem_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(12rem,auto)_minmax(11rem,14rem)]";

/**
 * The call as one row of the departures board: time, person, program, the
 * gate to the call, and one status word. In a narrow container each cell stacks and
 * carries its own label.
 */
export function CallStrip({
  meeting,
  now,
  leadName,
  bookedVia,
  programName,
  programValue,
}: CallStripProps) {
  const joinUrl = meeting.meetingJoinUrl ?? meeting.zoomJoinUrl;
  const status = callStatus(meeting, now);

  return (
    <section
      aria-label="This call"
      className="@container overflow-hidden rounded-xl bg-board text-board-foreground dark:ring-1 dark:ring-board-foreground/10"
    >
      <div
        aria-hidden
        className={cn(
          "hidden h-7 items-center gap-x-4 border-b border-board-line px-4 font-condensed text-[0.6875rem] font-semibold tracking-[0.14em] text-board-muted uppercase @4xl:grid",
          COLUMNS,
        )}
      >
        <span>Time</span>
        <span>Person</span>
        <span>Program</span>
        <span>Gate</span>
        <span>Status</span>
      </div>
      <div
        className={cn(
          "grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 @4xl:min-h-16 @4xl:items-center @4xl:gap-y-0 @4xl:py-2",
          COLUMNS,
        )}
      >
        <StripCell label="Time">
          <p className="font-condensed text-[1.625rem] leading-none font-semibold tabular-nums">
            {format(meeting.scheduledAt, "h:mm")}
            <span className="ml-1 text-sm font-medium text-board-muted">
              {format(meeting.scheduledAt, "a")}
            </span>
          </p>
          <p className="mt-1 text-[0.8125rem] text-board-muted tabular-nums">
            {format(meeting.scheduledAt, "EEE, MMM d")} · {meeting.durationMinutes} min
          </p>
        </StripCell>

        <StripCell label="Status" className="@4xl:order-last">
          <p
            className={cn(
              "flex items-center gap-2 font-condensed text-[1.0625rem] leading-none font-bold tracking-[0.08em] uppercase",
              TONE_WORD_CLASS[status.tone],
            )}
          >
            <span
              aria-hidden
              className={cn("size-2 shrink-0 rounded-full", TONE_DOT_CLASS[status.tone])}
            />
            {status.word}
          </p>
          <p
            className="mt-1 text-[0.8125rem] text-board-muted"
            suppressHydrationWarning
          >
            {status.detail}
          </p>
        </StripCell>

        <StripCell label="Person" className="col-span-2 @4xl:col-span-1">
          <h1 className="truncate text-lg leading-tight font-semibold" title={leadName}>
            {leadName}
          </h1>
          <p className="mt-0.5 truncate text-[0.8125rem] text-board-muted" title={bookedVia}>
            {bookedVia}
          </p>
        </StripCell>

        <StripCell label="Program" className="col-span-2 @4xl:col-span-1">
          <p className="truncate text-board-muted" title={programName ?? undefined}>
            <span className="font-semibold text-board-foreground">
              {programName ?? "No program mapped"}
            </span>
            {programValue ? <span className="tabular-nums"> · {programValue}</span> : null}
          </p>
        </StripCell>

        <StripCell label="Gate" className="col-span-2 @4xl:col-span-1">
          {joinUrl ? (
            <div className="flex flex-wrap gap-1.5">
              <Button
                asChild
                size="sm"
                className="h-8 border-board-foreground/15 bg-board-raised px-3 text-board-foreground hover:bg-board-raised/70 focus-visible:ring-primary/60"
              >
                <a href={joinUrl} target="_blank" rel="noopener noreferrer">
                  <VideoIcon data-icon="inline-start" aria-hidden />
                  {joinLabel(meeting, joinUrl)}
                </a>
              </Button>
              <CopyLinkButton url={joinUrl} />
            </div>
          ) : (
            <p className="text-[0.8125rem] text-board-muted">No call link on the booking</p>
          )}
        </StripCell>
      </div>
    </section>
  );
}

function StripCell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="mb-1 font-condensed text-[0.6875rem] font-semibold tracking-[0.14em] text-board-muted uppercase @4xl:sr-only">
        {label}
      </p>
      {children}
    </div>
  );
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      className="h-8 border-board-foreground/15 bg-board-raised px-3 text-board-foreground hover:bg-board-raised/70 focus-visible:ring-primary/60"
      onClick={async () => {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        toast.success("Call link copied");
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? (
        <CheckIcon data-icon="inline-start" aria-hidden />
      ) : (
        <CopyIcon data-icon="inline-start" aria-hidden />
      )}
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}
