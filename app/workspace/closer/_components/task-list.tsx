"use client";

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import type { api } from "@/convex/_generated/api";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import {
  addBusinessDays,
  businessDateForInstant,
  type BusinessDaySetting,
} from "@/lib/businessDay";
import type { TaskGroupKey } from "@/lib/closer-tasks";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatClock, formatShortDate } from "./today-time";

// The rows of the closer's task lists: Today's Tasks card and the queue on
// the task page. Groups come from `groupCloserTasks` (lib/closer-tasks.ts).

export type CloserTasks = FunctionReturnType<typeof api.closer.followUpQueries.getCloserTasks>;
export type CloserTask = CloserTasks["reminders"][number];

/** Where a row goes: a reminder's task page, or the deal for a link or a stale-deal nudge. */
export function taskHref(task: CloserTask): string {
  return task.type === "scheduling_link" || task.reason === "stale_opportunity_nudge"
    ? `/workspace/leads-customers/${task.leadId}?opportunityId=${task.opportunityId}`
    : `/workspace/closer/reminders/${task._id}`;
}

export function TasksHeader({
  titleId,
  total,
  meta,
  className,
}: {
  titleId: string;
  total?: number;
  meta?: string;
  className?: string;
}) {
  return (
    <header className={cn("flex min-h-[46px] items-center gap-2 border-b px-4 py-2", className)}>
      <h2 id={titleId} className="text-[15px] font-semibold">
        Tasks
      </h2>
      {total ? (
        <span className="rounded-full bg-secondary px-[7px] text-xs leading-[18px] font-semibold tabular-nums">
          {total}
        </span>
      ) : null}
      {meta ? <span className="ml-auto text-[13px] text-muted-foreground">{meta}</span> : null}
    </header>
  );
}

/** A group's ruled heading, "Overdue · 2", and its rows. */
export function TaskGroup({
  id,
  group,
  label,
  total,
  children,
}: {
  id: string;
  group: TaskGroupKey;
  label: string;
  total: number;
  children?: React.ReactNode;
}) {
  return (
    <div role="group" aria-labelledby={id}>
      <h3
        id={id}
        className={cn(
          "flex h-[26px] items-center border-t bg-background px-4 font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase first:border-t-0",
          group === "overdue" && "text-danger-ink",
        )}
      >
        {label} · {total}
      </h3>
      {children ? <ul>{children}</ul> : null}
    </div>
  );
}

export function TaskRow({
  task,
  group,
  today,
  setting,
  showAction = true,
  current = false,
}: {
  task: CloserTask;
  group: TaskGroupKey;
  today: string;
  setting: BusinessDaySetting;
  /** The row's Call, Text or Copy link button. The queue leaves it to the open task. */
  showAction?: boolean;
  /** The task open on the page, marked with the lime inset. */
  current?: boolean;
}) {
  const isLink = task.type === "scheduling_link";
  const isStaleNudge = task.reason === "stale_opportunity_nudge";
  const note =
    task.reminderNote ??
    (isLink
      ? "Link not booked yet"
      : isStaleNudge
        ? "Deal has gone quiet"
        : task.contactMethod === "text"
          ? "Text back"
          : "Call back");
  const reasonChip =
    task.reason === "no_show_follow_up"
      ? "No-show"
      : task.reason === "cancellation_follow_up"
        ? "Canceled"
        : null;
  const context = [
    task.programName,
    task.dealPosition ? dealPositionLabel(task.dealPosition) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li
      className={cn(
        "relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 border-t px-4 py-[7px] first:border-t-0 hover:bg-accent/60",
        current && "bg-primary/10 shadow-[inset_3px_0_0_var(--color-primary)] hover:bg-primary/15",
      )}
    >
      <p className="min-w-0 truncate">
        <Link
          href={taskHref(task)}
          aria-current={current ? "page" : undefined}
          className="font-semibold outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
        >
          {task.leadName}
        </Link>
        <span className="text-muted-foreground"> · {note}</span>
      </p>
      <span
        className={cn(
          "justify-self-end font-condensed text-sm font-semibold tracking-[0.02em] whitespace-nowrap text-muted-foreground",
          group === "overdue" && "text-danger-ink",
        )}
      >
        {dueLabel(task, group, today, setting)}
      </span>
      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
        {reasonChip ? (
          <span className="shrink-0 rounded-[4px] bg-destructive/10 px-1.5 font-condensed text-[11px] leading-[18px] font-bold tracking-[0.1em] text-danger-ink uppercase">
            {reasonChip}
          </span>
        ) : null}
        <span className="truncate">{context}</span>
      </p>
      {showAction ? (
        <div className="relative z-10 mt-0.5 justify-self-end">
          <TaskAction task={task} primary={group === "overdue"} />
        </div>
      ) : null}
    </li>
  );
}

/** "4:30 PM" today, "Yesterday", "Tomorrow", or "Oct 28"; a link says when it was sent. */
function dueLabel(task: CloserTask, group: TaskGroupKey, today: string, setting: BusinessDaySetting) {
  if (group === "waiting") return `Sent ${formatShortDate(task.createdAt, setting.timeZone)}`;
  const at = task.reminderScheduledAt ?? 0;
  const day = businessDateForInstant(at, setting);
  if (day === today) return formatClock(at, setting.timeZone);
  if (day === addBusinessDays(today, -1)) return "Yesterday";
  if (day === addBusinessDays(today, 1)) return "Tomorrow";
  return formatShortDate(at, setting.timeZone);
}

function TaskAction({ task, primary }: { task: CloserTask; primary: boolean }) {
  const variant = primary ? "default" : "outline";
  const className = "h-6 px-2 text-xs font-semibold";

  if (task.type === "scheduling_link") {
    if (!task.schedulingLinkUrl) return null;
    const url = task.schedulingLinkUrl;
    return (
      <Button
        variant={variant}
        size="xs"
        className={className}
        aria-label={`Copy the scheduling link for ${task.leadName}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            toast.success("Link copied");
          } catch {
            toast.error("Couldn't copy the link. Open the task to copy it.");
          }
        }}
      >
        Copy link
      </Button>
    );
  }

  if (task.reason === "stale_opportunity_nudge" || !task.leadPhone) return null;
  const text = task.contactMethod === "text";
  return (
    <Button asChild variant={variant} size="xs" className={className}>
      <a
        href={`${text ? "sms" : "tel"}:${task.leadPhone}`}
        aria-label={`${text ? "Text" : "Call"} ${task.leadName}`}
      >
        {text ? "Text" : "Call"}
      </a>
    </Button>
  );
}

export function TasksSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading tasks">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex flex-col gap-1.5 border-t px-4 py-2.5 first:border-t-0">
          <div className="flex justify-between gap-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-12" />
          </div>
          <div className="flex justify-between gap-3">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-6 w-12" />
          </div>
        </div>
      ))}
    </div>
  );
}
