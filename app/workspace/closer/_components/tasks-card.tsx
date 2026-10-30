"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { businessDateForInstant, businessDayRange, type BusinessDaySetting } from "@/lib/businessDay";
import { groupCloserTasks, type TaskGroupKey } from "@/lib/closer-tasks";
import { Button } from "@/components/ui/button";
import { SectionEmpty } from "./section-state";
import {
  TaskGroup,
  TaskRow,
  TasksHeader,
  TasksSkeleton,
  type CloserTask,
  type CloserTasks,
} from "./task-list";
import { useExpandInPlace } from "./use-expand-in-place";

/** At most this many rows show; "Show N more" scrolls the rest inside the card. */
const MAX_ROWS = 8;

// `getCloserTasks` reads at most this many of each kind, reminders soonest
// first (MAX_TASKS_PER_KIND in convex/closer/followUpQueries.ts). A partial
// result with a full reminder read may have cut reminders due after today.
const TASKS_READ_PER_KIND = 50;

type Group = { key: Exclude<TaskGroupKey, "later">; label: string; tasks: CloserTask[] };

/**
 * The closer's open tasks in three groups: reminders past due, reminders due
 * later today (business day), and scheduling links waiting on the person to
 * book. Reminders due after today are counted in the footer and listed under
 * All tasks. A row opens the task; its button calls, texts or copies the link.
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
          <TasksHeader titleId="tasks-title" />
          <TasksSkeleton />
        </>
      ) : (
        <TasksBody tasks={tasks} setting={setting} now={now} />
      )}
    </section>
  );
}

function TasksBody({ tasks, setting, now }: { tasks: CloserTasks; setting: BusinessDaySetting; now: number }) {
  const today = businessDateForInstant(now, setting);
  const { end: endOfToday } = businessDayRange(today, setting);
  const { overdue, today: dueToday, later, waiting } = groupCloserTasks(tasks, now, endOfToday);
  const { expanded, toggle, listProps } = useExpandInPlace<HTMLDivElement>(
    overdue.length + dueToday.length + waiting.length > MAX_ROWS,
  );

  // Fill the rows group by group, in order, up to MAX_ROWS; expanded, all of them.
  let room = expanded ? Number.POSITIVE_INFINITY : MAX_ROWS;
  const groups = (
    [
      { key: "overdue", label: "Overdue", tasks: overdue },
      { key: "today", label: "Today", tasks: dueToday },
      { key: "waiting", label: "Waiting on the person", tasks: waiting },
    ] satisfies Group[]
  ).map((group) => {
    const shown = group.tasks.slice(0, Math.max(0, room));
    room -= shown.length;
    return { ...group, total: group.tasks.length, tasks: shown };
  });

  const total = tasks.reminders.length + tasks.schedulingLinks.length;
  const hidden = groups.reduce((sum, group) => sum + group.total - group.tasks.length, 0);
  const canExpand = expanded || hidden > 0;
  // `isPartial` is one flag for both kinds of task: it marks the total, and
  // the later count only when the reminder read itself was full.
  const laterPartial = tasks.isPartial && tasks.reminders.length >= TASKS_READ_PER_KIND;
  const meta = [
    overdue.length > 0 ? `${overdue.length} overdue` : null,
    dueToday.length > 0 ? `${dueToday.length} today` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (total === 0) {
    return (
      <>
        <TasksHeader titleId="tasks-title" />
        <SectionEmpty title="No open tasks.">
          Call-backs and scheduling links you set from a call land here.
        </SectionEmpty>
      </>
    );
  }

  return (
    <>
      <TasksHeader
        titleId="tasks-title"
        total={total}
        partial={tasks.isPartial}
        meta={meta || undefined}
      />
      <div {...listProps}>
        {groups.map((group) =>
          group.total === 0 ? null : (
            <TaskGroup
              key={group.key}
              id={`tasks-${group.key}`}
              group={group.key}
              label={group.label}
              total={group.total}
            >
              {group.tasks.length > 0
                ? group.tasks.map((task) => (
                    <TaskRow
                      key={task._id}
                      task={task}
                      group={group.key}
                      today={today}
                      setting={setting}
                    />
                  ))
                : null}
            </TaskGroup>
          ),
        )}
      </div>
      {/* Always offer the full list; reminders due after today live there. */}
      <footer className="mt-auto flex min-h-[38px] items-center justify-between gap-3 border-t px-4 text-[13px] font-medium text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {canExpand ? (
            <Button
              variant="link"
              size="sm"
              className="h-7 px-0 text-[13px] text-foreground"
              aria-expanded={expanded}
              onClick={toggle}
            >
              {expanded ? "Show fewer" : `Show ${hidden} more`}
            </Button>
          ) : null}
          {later.length > 0 ? (
            <span>
              {canExpand ? "· " : ""}
              {later.length}
              {laterPartial ? "+" : ""} later
            </span>
          ) : null}
        </span>
        <Link
          href="/workspace/closer/reminders"
          className="inline-flex min-h-6 items-center rounded-sm text-foreground underline underline-offset-[3px] outline-none hover:text-primary-ink focus-visible:ring-2 focus-visible:ring-ring"
        >
          All tasks
        </Link>
      </footer>
    </>
  );
}
