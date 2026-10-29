"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowUpRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import type { DealPosition } from "@/convex/opportunities/stages";
import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { formatAmountMinor } from "@/lib/format-currency";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BOARD_STATUS_LABEL,
  boardStatus,
  boardingCountdown,
  gateLabel,
  type BoardStatus,
  type NextCall,
} from "./board-status";
import {
  boardRange,
  clockParts,
  formatBusinessDate,
  formatDateTime,
  type BoardTab,
} from "./today-time";

type BoardEntry = FunctionReturnType<
  typeof api.closer.calendar.getMeetingsForRange
>["meetings"][number];
export type { BoardEntry };

const TABS: Array<{ value: BoardTab; label: string; title: string; empty: string }> = [
  { value: "today", label: "Today", title: "Today's calls", empty: "No calls today." },
  { value: "tomorrow", label: "Tomorrow", title: "Tomorrow's calls", empty: "No calls tomorrow." },
  { value: "week", label: "This week", title: "This week's calls", empty: "No calls this week." },
];

// The status word's colour on the navy board. The board scopes the dark
// theme's tokens (see `TodaysCallsBoard`), so each -ink here is the light ink
// made for a dark surface.
const STATUS_TEXT: Record<BoardStatus, string> = {
  boarding: "text-primary-foreground",
  on_time: "text-board-foreground",
  not_recorded: "text-warning-ink",
  held: "text-stage-held-ink",
  no_show: "text-stage-lost-ink",
  canceled: "text-board-muted",
};

const POSITION_TEXT: Record<DealPosition, string> = {
  qualified: "text-board-muted",
  booked: "text-stage-booked-ink",
  call_held: "text-stage-held-ink",
  follow_up: "text-stage-follow-up-ink",
  won: "text-stage-won-ink",
  lost: "text-stage-lost-ink",
};

/**
 * The closer's calls as a departures board: Today, Tomorrow or This week by
 * business day, one condensed status word per call, and the next or live
 * call as a lime Boarding row with Join and a countdown. Each row opens its
 * meeting.
 */
export function TodaysCallsBoard({
  setting,
  now,
  next,
}: {
  setting: BusinessDaySetting;
  now: number;
  next: NextCall | null;
}) {
  const [tab, setTab] = useState<BoardTab>("today");
  // Ranges move only when the business day does, not with every clock tick.
  const businessDate = businessDateForInstant(now, setting);
  const range = useMemo(
    () => boardRange(tab, businessDate, setting),
    [tab, businessDate, setting],
  );
  const calls = useQuery(api.closer.calendar.getMeetingsForRange, {
    startDate: range.start,
    endDate: range.end,
  });

  return (
    <CallsBoardView
      tab={tab}
      onTabChange={setTab}
      meetings={calls?.meetings}
      isPartial={calls?.isPartial ?? false}
      next={next}
      now={now}
      setting={setting}
    />
  );
}

/** The board itself, from the calls it's given: loading, empty, or rows. */
export function CallsBoardView({
  tab,
  onTabChange,
  meetings,
  isPartial,
  next,
  now,
  setting,
}: {
  tab: BoardTab;
  onTabChange: (tab: BoardTab) => void;
  meetings: BoardEntry[] | undefined;
  isPartial: boolean;
  next: NextCall | null;
  now: number;
  setting: BusinessDaySetting;
}) {
  const active = TABS.find((entry) => entry.value === tab)!;

  return (
    <section
      aria-labelledby="todays-calls-title"
      className="overflow-hidden rounded-xl border border-board-line bg-board text-sm text-board-foreground"
    >
      {/* The board is a dark surface in both themes: `dark` scopes the dark
          theme's tokens to it, so text, inks and focus rings are the ones
          made for a dark ground. The navy itself comes from the page's theme. */}
      <Tabs value={tab} onValueChange={(value) => onTabChange(value as BoardTab)} className="dark gap-0">
        <header className="flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-[18px]">
          <h2
            id="todays-calls-title"
            className="font-condensed text-[19px] leading-none font-semibold tracking-[0.02em]"
          >
            {active.title}
          </h2>
          {meetings && meetings.length > 0 ? (
            <p className="text-[13px] text-board-muted">{boardSummary(meetings, now)}</p>
          ) : null}
          <TabsList className="ml-auto h-[30px] rounded-[7px] bg-background/50 p-0.5" aria-label="Which calls">
            {TABS.map((entry) => (
              <TabsTrigger
                key={entry.value}
                value={entry.value}
                className="h-[26px] px-2.5 text-[13px] text-board-muted hover:text-board-foreground data-active:bg-accent data-active:text-board-foreground dark:data-active:border-transparent dark:data-active:bg-accent"
              >
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </header>

        {TABS.map((entry) => (
          <TabsContent key={entry.value} value={entry.value} className="text-board-foreground">
            {meetings === undefined ? (
              <BoardSkeleton />
            ) : meetings.length === 0 ? (
              <BoardEmpty
                title={entry.empty}
                next={entry.value === "today" ? next : null}
                timeZone={setting.timeZone}
              />
            ) : (
              <>
                <BoardTable
                  meetings={meetings}
                  nextMeetingId={next?.meetingId ?? null}
                  now={now}
                  setting={setting}
                  groupByDay={entry.value === "week"}
                />
                <BoardList
                  meetings={meetings}
                  nextMeetingId={next?.meetingId ?? null}
                  now={now}
                  setting={setting}
                  groupByDay={entry.value === "week"}
                />
                {isPartial ? (
                  <p className="border-t border-board-line px-[18px] py-2 text-xs text-board-muted">
                    Showing the first {meetings.length.toLocaleString()} calls.
                  </p>
                ) : null}
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}

/** "5 calls · 1 held · 4 to go": canceled calls aren't counted. */
function boardSummary(meetings: BoardEntry[], now: number) {
  const live = meetings.filter(({ meeting }) => meeting.status !== "canceled");
  const held = live.filter(({ meeting }) => meeting.status === "held").length;
  const toGo = live.filter(
    ({ meeting }) =>
      meeting.status === "scheduled" &&
      meeting.scheduledAt + meeting.durationMinutes * 60_000 > now,
  ).length;
  const parts = [`${live.length} ${live.length === 1 ? "call" : "calls"}`];
  if (held > 0) parts.push(`${held} held`);
  if (toGo > 0) parts.push(`${toGo} to go`);
  return parts.join(" · ");
}

type RowProps = {
  meetings: BoardEntry[];
  nextMeetingId: string | null;
  now: number;
  setting: BusinessDaySetting;
  groupByDay: boolean;
};

/** The calls, with a day heading before each business day when grouped. */
function withDays(meetings: BoardEntry[], setting: BusinessDaySetting, groupByDay: boolean) {
  const out: Array<{ day: string } | { entry: BoardEntry }> = [];
  let lastDay: string | null = null;
  for (const entry of meetings) {
    if (groupByDay) {
      const day = businessDateForInstant(entry.meeting.scheduledAt, setting);
      if (day !== lastDay) {
        out.push({ day });
        lastDay = day;
      }
    }
    out.push({ entry });
  }
  return out;
}

function sortedCalls(meetings: BoardEntry[]) {
  return [...meetings].sort((a, b) => a.meeting.scheduledAt - b.meeting.scheduledAt);
}

const meetingHref = (id: string) => `/workspace/closer/meetings/${id}`;
const programOf = (entry: BoardEntry) =>
  entry.meeting.bookingProgramName ?? entry.eventTypeName ?? null;
const joinUrlOf = (entry: BoardEntry) =>
  entry.meeting.meetingJoinUrl ?? entry.meeting.zoomJoinUrl ?? null;

// A link that covers its whole row; the row's own buttons sit above it.
const ROW_LINK =
  "outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring";

/** md and up: the board as a table. */
function BoardTable({ meetings, nextMeetingId, now, setting, groupByDay }: RowProps) {
  return (
    <Table className="hidden table-fixed md:table">
      <colgroup>
        <col className="w-[96px]" />
        <col />
        <col className="w-[26%]" />
        <col className="w-[96px]" />
        <col className="w-[176px]" />
      </colgroup>
      <TableHeader className="[&_tr]:border-b-0">
        <TableRow className="h-7 border-t border-board-line hover:bg-transparent">
          {["Time", "Person", "Program", "Gate", "Status"].map((label, index) => (
            <TableHead
              key={label}
              className={cn(
                "h-7 font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase",
                index === 0 && "pl-[18px]",
              )}
            >
              {label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {withDays(sortedCalls(meetings), setting, groupByDay).map((item) =>
          "day" in item ? (
            <TableRow key={item.day} className="h-7 border-t border-b-0 border-board-line hover:bg-transparent">
              <TableHead
                colSpan={5}
                scope="colgroup"
                className="h-7 bg-accent/40 pl-[18px] font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase"
              >
                {formatBusinessDate(item.day, { weekday: "short", month: "short", day: "numeric" })}
              </TableHead>
            </TableRow>
          ) : (
            <BoardTableRow
              key={item.entry.meeting._id}
              entry={item.entry}
              status={boardStatus(item.entry.meeting, nextMeetingId, now)}
              now={now}
              timeZone={setting.timeZone}
            />
          ),
        )}
      </TableBody>
    </Table>
  );
}

function BoardTableRow({
  entry,
  status,
  now,
  timeZone,
}: {
  entry: BoardEntry;
  status: BoardStatus;
  now: number;
  timeZone: string;
}) {
  const { meeting } = entry;
  const boarding = status === "boarding";
  const dim = status === "held" || status === "canceled";
  const { time, dayPeriod } = clockParts(meeting.scheduledAt, timeZone);
  const program = programOf(entry);
  const gate = gateLabel(meeting.meetingLocationType);
  const joinUrl = joinUrlOf(entry);

  return (
    <TableRow
      className={cn(
        "relative border-t border-b-0 border-board-line",
        boarding
          ? "h-14 border-transparent bg-primary text-primary-foreground hover:bg-primary"
          : "h-11 hover:bg-accent/50",
      )}
    >
      <TableCell className="pl-[18px]">
        <span
          className={cn(
            "font-condensed leading-none font-semibold tabular-nums",
            boarding ? "text-[26px]" : "text-xl",
            dim && "text-board-muted",
          )}
        >
          <span className={cn(status === "canceled" && "line-through")}>{time}</span>
          <span
            className={cn(
              "ml-[3px] text-xs font-medium",
              boarding ? "text-primary-foreground/80" : "text-board-muted",
            )}
          >
            {dayPeriod}
          </span>
        </span>
      </TableCell>
      <TableCell className="truncate">
        <Link
          href={meetingHref(meeting._id)}
          className={cn(
            ROW_LINK,
            "font-semibold",
            boarding && "text-[15px] focus-visible:after:ring-board",
            dim && "text-board-muted",
          )}
        >
          {entry.leadName}
        </Link>
        <span
          className={cn(
            "ml-1.5 text-[13px]",
            boarding ? "text-primary-foreground/80" : "text-board-muted",
          )}
        >
          {meeting.durationMinutes} min
        </span>
      </TableCell>
      <TableCell
        className={cn(
          "truncate",
          boarding ? "font-semibold" : dim ? "text-board-muted" : "text-board-foreground/80",
        )}
      >
        {program ?? <span className="text-board-muted">—</span>}
      </TableCell>
      <TableCell className={cn("truncate", boarding ? "" : dim ? "text-board-muted" : "text-board-foreground/80")}>
        {boarding && joinUrl ? (
          <JoinButton href={joinUrl} name={entry.leadName} />
        ) : (
          (gate ?? <span className="text-board-muted">—</span>)
        )}
      </TableCell>
      <TableCell>
        <StatusWord entry={entry} status={status} now={now} />
      </TableCell>
    </TableRow>
  );
}

function StatusWord({
  entry,
  status,
  now,
}: {
  entry: BoardEntry;
  status: BoardStatus;
  now: number;
}) {
  const countdown =
    status === "boarding" ? boardingCountdown(entry.meeting.scheduledAt, now) : null;
  return (
    <span className="flex items-center gap-2.5 whitespace-nowrap">
      <span
        className={cn(
          "font-condensed text-[15px] leading-none font-bold tracking-[0.08em] uppercase",
          STATUS_TEXT[status],
        )}
      >
        {BOARD_STATUS_LABEL[status]}
      </span>
      {countdown ? (
        <span
          className="font-condensed text-[22px] leading-none font-bold tabular-nums"
          title={countdown.label}
        >
          <span className="sr-only">{countdown.label}</span>
          <span aria-hidden="true">
            {countdown.value}
            {countdown.unit ? (
              <span className="ml-px text-xs font-semibold uppercase">{countdown.unit}</span>
            ) : null}
          </span>
        </span>
      ) : null}
      {status === "held" && entry.dealPosition ? (
        <span className={cn("text-[13px] font-semibold", POSITION_TEXT[entry.dealPosition])}>
          {dealPositionLabel(entry.dealPosition, entry.dealSystemLoss)}
          {entry.dealPosition === "won" && entry.wonAmount
            ? ` · ${wholeAmount(entry.wonAmount)}`
            : null}
        </span>
      ) : null}
    </span>
  );
}

/** "$3,500" for a whole amount, "$3,500.50" otherwise, in the payment's currency. */
function wholeAmount({ amountMinor, currency }: { amountMinor: number; currency: string }) {
  const formatted = formatAmountMinor(amountMinor, currency);
  return amountMinor % 100 === 0 ? formatted.replace(/\.00(?=\D*$)/, "") : formatted;
}

function JoinButton({ href, name }: { href: string; name: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Join the call with ${name} (opens in a new tab)`}
      className="relative z-10 inline-flex h-8 items-center gap-1.5 rounded-[7px] bg-board px-3 text-sm font-semibold text-board-foreground transition-colors outline-none hover:bg-board-raised focus-visible:ring-2 focus-visible:ring-board focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
    >
      Join
      <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
    </a>
  );
}

/** Below md: the board as a stacked list. */
function BoardList({ meetings, nextMeetingId, now, setting, groupByDay }: RowProps) {
  return (
    <ul className="md:hidden">
      {withDays(sortedCalls(meetings), setting, groupByDay).map((item) =>
        "day" in item ? (
          <li
            key={item.day}
            className="border-t border-board-line bg-accent/40 px-4 py-1.5 font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase"
          >
            {formatBusinessDate(item.day, { weekday: "short", month: "short", day: "numeric" })}
          </li>
        ) : (
          <BoardListItem
            key={item.entry.meeting._id}
            entry={item.entry}
            status={boardStatus(item.entry.meeting, nextMeetingId, now)}
            now={now}
            timeZone={setting.timeZone}
          />
        ),
      )}
    </ul>
  );
}

function BoardListItem({
  entry,
  status,
  now,
  timeZone,
}: {
  entry: BoardEntry;
  status: BoardStatus;
  now: number;
  timeZone: string;
}) {
  const { meeting } = entry;
  const boarding = status === "boarding";
  const dim = status === "held" || status === "canceled";
  const { time, dayPeriod } = clockParts(meeting.scheduledAt, timeZone);
  const program = programOf(entry);
  const gate = gateLabel(meeting.meetingLocationType);
  const joinUrl = joinUrlOf(entry);
  const detail = [`${meeting.durationMinutes} min`, program, gate].filter(Boolean).join(" · ");

  return (
    <li
      className={cn(
        "relative grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-board-line px-4 py-2.5",
        boarding && "border-transparent bg-primary text-primary-foreground",
      )}
    >
      <span
        className={cn(
          "row-span-2 font-condensed text-xl leading-none font-semibold tabular-nums",
          dim && "text-board-muted",
        )}
      >
        <span className={cn(status === "canceled" && "line-through")}>{time}</span>
        <span className={cn("ml-0.5 text-[11px] font-medium", boarding ? "text-primary-foreground/80" : "text-board-muted")}>
          {dayPeriod}
        </span>
      </span>
      <div className="min-w-0">
        <Link
          href={meetingHref(meeting._id)}
          className={cn(
            ROW_LINK,
            "block truncate font-semibold",
            boarding && "focus-visible:after:ring-board",
            dim && "text-board-muted",
          )}
        >
          {entry.leadName}
        </Link>
        <p className={cn("truncate text-[13px]", boarding ? "text-primary-foreground/80" : "text-board-muted")}>
          {detail}
        </p>
      </div>
      <div className="col-start-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <StatusWord entry={entry} status={status} now={now} />
        {boarding && joinUrl ? <JoinButton href={joinUrl} name={entry.leadName} /> : null}
      </div>
    </li>
  );
}

function BoardEmpty({
  title,
  next,
  timeZone,
}: {
  title: string;
  next: NextCall | null;
  timeZone: string;
}) {
  return (
    <div className="border-t border-board-line px-[18px] py-5 text-sm">
      <p className="font-medium">{title}</p>
      {next ? (
        <p className="mt-1 text-board-muted">
          Next call:{" "}
          <Link
            href={meetingHref(next.meetingId)}
            className="font-medium text-board-foreground underline decoration-board-muted underline-offset-[3px] outline-none hover:decoration-board-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
          >
            {next.leadName}, {formatDateTime(next.scheduledAt, timeZone)}
          </Link>
        </p>
      ) : (
        <p className="mt-1 text-board-muted">Calls appear here as people book through Calendly.</p>
      )}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div role="status" aria-label="Loading calls" className="border-t border-board-line">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex h-11 items-center gap-4 border-b border-board-line px-[18px] last:border-b-0">
          <Skeleton className="h-5 w-14 bg-accent" />
          <Skeleton className="h-4 w-40 bg-accent" />
          <Skeleton className="ml-auto h-4 w-20 bg-accent" />
        </div>
      ))}
    </div>
  );
}
