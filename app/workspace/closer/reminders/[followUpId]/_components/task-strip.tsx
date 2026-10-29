"use client";

import type { DealPosition, SystemLossReason } from "@/convex/opportunities/stages";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import {
  addBusinessDays,
  businessDateForInstant,
  type BusinessDaySetting,
} from "@/lib/businessDay";
import { formatPastDue, taskTiming } from "@/lib/closer-tasks";
import { cn } from "@/lib/utils";
import {
  clockParts,
  formatBusinessDate,
  formatClock,
  formatShortDate,
} from "@/app/workspace/closer/_components/today-time";
import type { TaskDetail } from "./task-detail-types";

type StripTone = "due" | "overdue" | "neutral" | "done";

const TONE_WORD_CLASS: Record<StripTone, string> = {
  due: "text-warning",
  overdue: "text-board-danger",
  neutral: "text-board-foreground",
  done: "text-board-foreground",
};

const TONE_DOT_CLASS: Record<StripTone, string> = {
  due: "bg-warning",
  overdue: "bg-board-danger",
  neutral: "bg-stage-booked",
  done: "bg-stage-held",
};

/** "Today", "Tomorrow" or "Yesterday" for a business date near today, else null. */
function nearDayWord(dateKey: string, today: string): string | null {
  if (dateKey === today) return "Today";
  if (dateKey === addBusinessDays(today, 1)) return "Tomorrow";
  if (dateKey === addBusinessDays(today, -1)) return "Yesterday";
  return null;
}

/**
 * The task's one status word, read like the departures board: "Due 4:15 PM"
 * while it is upcoming, "Due now" within its minute, "Overdue" with how long,
 * and "Done" once an outcome closed it.
 */
function stripStatus(
  followUp: TaskDetail["followUp"],
  now: number,
  setting: BusinessDaySetting,
): { word: string; detail: string; tone: StripTone } {
  const timing = taskTiming(followUp, now);
  const due = followUp.reminderScheduledAt ?? null;
  const today = businessDateForInstant(now, setting);

  switch (timing.kind) {
    case "done":
      return {
        word: "Done",
        detail: followUp.completedAt
          ? `Closed ${formatShortDate(followUp.completedAt, setting.timeZone)}`
          : "Closed",
        tone: "done",
      };
    case "overdue":
      return { word: "Overdue", detail: `${timing.past} past due`, tone: "overdue" };
    case "due_now":
      return { word: "Due now", detail: "Reach out now", tone: "due" };
    case "upcoming": {
      if (due === null) return { word: "Open", detail: "No due time", tone: "neutral" };
      const day = businessDateForInstant(due, setting);
      return {
        word:
          day === today
            ? `Due ${formatClock(due, setting.timeZone)}`
            : `Due ${nearDayWord(day, today) ?? formatShortDate(due, setting.timeZone)}`,
        detail: `In ${formatPastDue(due - now)}`,
        tone: "neutral",
      };
    }
  }
}

type TaskStripProps = {
  followUp: TaskDetail["followUp"];
  now: number;
  setting: BusinessDaySetting;
  personName: string;
  /** "Call back · set Oct 27". */
  personLine: string;
  programName: string | null;
  position: DealPosition;
  systemLoss: SystemLossReason | null;
  /** "2 calls", after the deal's stage. */
  dealLine: string;
  phone: string | null;
};

const COLUMNS =
  "@3xl:grid-cols-[6.25rem_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(7.5rem,auto)]";

/**
 * The task as one row of the departures board: when it is due, the person,
 * the deal, how to reach them, and one status word. In a narrow container
 * each cell stacks and carries its own label. The call page's `CallStrip`
 * is its sibling.
 */
export function TaskStrip({
  followUp,
  now,
  setting,
  personName,
  personLine,
  programName,
  position,
  systemLoss,
  dealLine,
  phone,
}: TaskStripProps) {
  const due = followUp.reminderScheduledAt ?? null;
  const status = stripStatus(followUp, now, setting);
  const today = businessDateForInstant(now, setting);
  const dueClock = due === null ? null : clockParts(due, setting.timeZone);
  const dueDay = due === null ? null : businessDateForInstant(due, setting);
  const dueDayLine =
    dueDay === null
      ? "No due time"
      : nearDayWord(dueDay, today)
        ? `${nearDayWord(dueDay, today)}, ${formatBusinessDate(dueDay, { month: "short", day: "numeric" })}`
        : formatBusinessDate(dueDay, { weekday: "short", month: "short", day: "numeric" });
  const method = followUp.contactMethod === "text" ? "Text" : "Call";

  return (
    <section
      aria-label="This task"
      className="@container overflow-hidden rounded-xl bg-board text-board-foreground dark:ring-1 dark:ring-board-foreground/10"
    >
      <div
        aria-hidden
        className={cn(
          "hidden h-7 items-center gap-x-3.5 border-b border-board-line px-4 font-condensed text-[0.6875rem] font-semibold tracking-[0.14em] text-board-muted uppercase @3xl:grid",
          COLUMNS,
        )}
      >
        <span>Due</span>
        <span>Person</span>
        <span>Deal</span>
        <span>Reach by</span>
        <span>Status</span>
      </div>
      <div
        className={cn(
          "grid grid-cols-2 gap-x-3.5 gap-y-3 px-4 py-3 @3xl:min-h-16 @3xl:items-center @3xl:gap-y-0 @3xl:py-2",
          COLUMNS,
        )}
      >
        <StripCell label="Due">
          <p className="font-condensed text-[1.625rem] leading-none font-semibold tabular-nums">
            {dueClock ? (
              <>
                {dueClock.time}
                <span className="ml-1 text-sm font-medium text-board-muted">
                  {dueClock.dayPeriod}
                </span>
              </>
            ) : (
              "—"
            )}
          </p>
          <p className="mt-1 truncate text-[0.8125rem] text-board-muted tabular-nums">
            {dueDayLine}
          </p>
        </StripCell>

        <StripCell label="Status" className="@3xl:order-last">
          <p
            className={cn(
              "flex items-center gap-2 font-condensed text-[1.0625rem] leading-none font-bold tracking-[0.08em] whitespace-nowrap uppercase",
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
            className="mt-1 text-[0.8125rem] text-board-muted tabular-nums"
            suppressHydrationWarning
          >
            {status.detail}
          </p>
        </StripCell>

        <StripCell label="Person" className="col-span-2 @3xl:col-span-1">
          <h1 className="truncate text-lg leading-tight font-semibold" title={personName}>
            {personName}
          </h1>
          <p className="mt-0.5 truncate text-[0.8125rem] text-board-muted" title={personLine}>
            {personLine}
          </p>
        </StripCell>

        <StripCell label="Deal" className="col-span-2 @3xl:col-span-1">
          <p className="truncate font-semibold" title={programName ?? undefined}>
            {programName ?? "No program mapped"}
          </p>
          <p className="mt-0.5 truncate text-[0.8125rem] text-board-muted tabular-nums">
            {dealPositionLabel(position, systemLoss)} · {dealLine}
          </p>
        </StripCell>

        <StripCell label="Reach by" className="col-span-2 @3xl:col-span-1">
          <p className="truncate text-board-muted tabular-nums">
            <span className="font-semibold text-board-foreground">{method}</span>
            {" · "}
            {phone ?? "No phone on file"}
          </p>
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
      <p className="mb-1 font-condensed text-[0.6875rem] font-semibold tracking-[0.14em] text-board-muted uppercase @3xl:sr-only">
        {label}
      </p>
      {children}
    </div>
  );
}
