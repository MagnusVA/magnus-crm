"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import { businessDateForInstant, businessDayRange, addBusinessDays, type BusinessDaySetting } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionEmpty } from "./section-state";
import { formatClock, formatShortDate } from "./today-time";

type Tasks = FunctionReturnType<typeof api.closer.followUpQueries.getCloserTasks>;
type Task = Tasks["reminders"][number];

/** At most this many rows show; the rest are the footer's "N more". */
const MAX_ROWS = 8;

type Group = { key: "overdue" | "today" | "waiting"; label: string; tasks: Task[] };

/**
 * The closer's open tasks in three groups: reminders past due, reminders due
 * later today (business day), and scheduling links waiting on the person to
 * book. Reminders due after today are counted in the footer. A row opens the
 * task; its button calls, texts or copies the link.
 *
 * There's no Done checkbox: a reminder is closed on its own page by an
 * outcome (payment, lost, or no response), and a scheduling link by the
 * booking it leads to.
 */
export function TasksCard({ setting, now }: { setting: BusinessDaySetting; now: number }) {
  const tasks = useQuery(api.closer.followUpQueries.getCloserTasks, {});

  return (
    <section aria-labelledby="tasks-title" className="flex flex-col rounded-xl border bg-card text-sm text-card-foreground">
      {tasks === undefined ? (
        <>
          <TasksHeader />
          <TasksSkeleton />
        </>
      ) : (
        <TasksBody tasks={tasks} setting={setting} now={now} />
      )}
    </section>
  );
}

function TasksHeader({ total, meta }: { total?: number; meta?: string }) {
  return (
    <header className="flex min-h-[46px] items-center gap-2 border-b px-4 py-2">
      <h2 id="tasks-title" className="text-[15px] font-semibold">
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

function TasksBody({ tasks, setting, now }: { tasks: Tasks; setting: BusinessDaySetting; now: number }) {
  const today = businessDateForInstant(now, setting);
  const { end: endOfToday } = businessDayRange(today, setting);

  const dueAt = (task: Task) => task.reminderScheduledAt ?? 0;
  const overdue = tasks.reminders.filter((task) => dueAt(task) < now);
  const dueToday = tasks.reminders.filter((task) => dueAt(task) >= now && dueAt(task) < endOfToday);
  const later = tasks.reminders.length - overdue.length - dueToday.length;
  const waiting = [...tasks.schedulingLinks].sort((a, b) => b.createdAt - a.createdAt);

  // Fill the rows group by group, in order, up to MAX_ROWS.
  let room = MAX_ROWS;
  const groups = (
    [
      { key: "overdue", label: "Overdue", tasks: overdue },
      { key: "today", label: "Today", tasks: dueToday },
      { key: "waiting", label: "Waiting on the lead", tasks: waiting },
    ] satisfies Group[]
  ).map((group) => {
    const shown = group.tasks.slice(0, Math.max(0, room));
    room -= shown.length;
    return { ...group, total: group.tasks.length, tasks: shown };
  });

  const total = tasks.reminders.length + tasks.schedulingLinks.length;
  const shownCount = groups.reduce((sum, group) => sum + group.tasks.length, 0);
  const more = total - shownCount;
  const meta = [
    overdue.length > 0 ? `${overdue.length} overdue` : null,
    dueToday.length > 0 ? `${dueToday.length} today` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (total === 0) {
    return (
      <>
        <TasksHeader />
        <SectionEmpty title="No open tasks.">
          Reminders and scheduling links you send from a call land here.
        </SectionEmpty>
      </>
    );
  }

  return (
    <>
      <TasksHeader total={total} meta={meta || undefined} />
      {groups.map((group) =>
        group.total === 0 ? null : (
          <div key={group.key} role="group" aria-labelledby={`tasks-${group.key}`}>
            <h3
              id={`tasks-${group.key}`}
              className={cn(
                "flex h-[26px] items-center border-t bg-background px-4 font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase first:border-t-0",
                group.key === "overdue" && "text-danger-ink",
              )}
            >
              {group.label} · {group.total}
            </h3>
            {group.tasks.length > 0 ? (
              <ul>
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task._id}
                    task={task}
                    group={group.key}
                    today={today}
                    setting={setting}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        ),
      )}
      {/* Always offer the full list; say how many aren't shown here. */}
      <footer className="mt-auto flex min-h-[38px] items-center justify-between gap-3 border-t px-4 text-[13px] font-medium text-muted-foreground">
        <span>
          {more > 0 ? `${more}${tasks.isPartial ? "+" : ""} more` : ""}
          {more > 0 && later > 0 && later === more ? " later" : ""}
        </span>
        <Link
          href="/workspace/closer/pipeline?stage=follow_up"
          className="inline-flex min-h-6 items-center rounded-sm text-foreground underline underline-offset-[3px] outline-none hover:text-primary-ink focus-visible:ring-2 focus-visible:ring-ring"
        >
          All tasks
        </Link>
      </footer>
    </>
  );
}

function TaskRow({
  task,
  group,
  today,
  setting,
}: {
  task: Task;
  group: Group["key"];
  today: string;
  setting: BusinessDaySetting;
}) {
  const isLink = task.type === "scheduling_link";
  const isStaleNudge = task.reason === "stale_opportunity_nudge";
  const href =
    isLink || isStaleNudge
      ? `/workspace/leads-customers/${task.leadId}?opportunityId=${task.opportunityId}`
      : `/workspace/closer/reminders/${task._id}`;
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
    <li className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 border-t px-4 py-[7px] first:border-t-0 hover:bg-accent/60">
      <p className="min-w-0 truncate">
        <Link
          href={href}
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
      <div className="relative z-10 mt-0.5 justify-self-end">
        <TaskAction task={task} primary={group === "overdue"} />
      </div>
    </li>
  );
}

function dueLabel(task: Task, group: Group["key"], today: string, setting: BusinessDaySetting) {
  if (group === "waiting") return `Sent ${formatShortDate(task.createdAt, setting.timeZone)}`;
  const at = task.reminderScheduledAt ?? 0;
  const day = businessDateForInstant(at, setting);
  if (day === today) return formatClock(at, setting.timeZone);
  if (day === addBusinessDays(today, -1)) return "Yesterday";
  return formatShortDate(at, setting.timeZone);
}

function TaskAction({ task, primary }: { task: Task; primary: boolean }) {
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

function TasksSkeleton() {
  return (
    <div role="status" aria-label="Loading tasks">
      {Array.from({ length: 3 }).map((_, index) => (
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
