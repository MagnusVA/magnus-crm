"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { businessDateForInstant, businessDayRange, type BusinessDaySetting } from "@/lib/businessDay";
import { groupCloserTasks, type TaskGroupKey } from "@/lib/closer-tasks";
import { SectionEmpty } from "./section-state";
import {
  TaskGroup,
  TaskRow,
  TasksHeader,
  TasksSkeleton,
  type CloserTask,
  type CloserTasks,
} from "./task-list";

/** At most this many rows show; the rest are the footer's "N more". */
const MAX_ROWS = 8;

type Group = { key: Exclude<TaskGroupKey, "later">; label: string; tasks: CloserTask[] };

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

  // Fill the rows group by group, in order, up to MAX_ROWS.
  let room = MAX_ROWS;
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
        <TasksHeader titleId="tasks-title" />
        <SectionEmpty title="No open tasks.">
          Call-backs and scheduling links you set from a call land here.
        </SectionEmpty>
      </>
    );
  }

  return (
    <>
      <TasksHeader titleId="tasks-title" total={total} meta={meta || undefined} />
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
      {/* Always offer the full list; say how many aren't shown here. */}
      <footer className="mt-auto flex min-h-[38px] items-center justify-between gap-3 border-t px-4 text-[13px] font-medium text-muted-foreground">
        <span>
          {more > 0 ? `${more}${tasks.isPartial ? "+" : ""} more` : ""}
          {more > 0 && later.length > 0 && later.length === more ? " later" : ""}
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
