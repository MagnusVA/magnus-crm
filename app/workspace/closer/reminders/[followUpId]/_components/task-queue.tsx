"use client";

import { useState } from "react";
import Link from "next/link";
import { ListTodoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  businessDateForInstant,
  businessDayRange,
  type BusinessDaySetting,
} from "@/lib/businessDay";
import { groupCloserTasks, type TaskGroupKey } from "@/lib/closer-tasks";
import {
  TaskGroup,
  TaskRow,
  TasksHeader,
  TasksSkeleton,
  type CloserTasks,
} from "@/app/workspace/closer/_components/task-list";

const GROUPS: Array<{ key: TaskGroupKey; label: string }> = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "later", label: "Later" },
  { key: "waiting", label: "Waiting on the person" },
];

type TaskQueueProps = {
  /** `getCloserTasks`, undefined while it loads. */
  tasks: CloserTasks | undefined;
  currentId: string;
  now: number;
  setting: BusinessDaySetting;
  /** Keeps heading ids unique between the side list and the sheet. */
  idPrefix: string;
};

/**
 * The closer's open tasks, the same rows and groups as Today's Tasks card,
 * plus the reminders due after today so any task can be opened from here.
 * The open task carries the lime inset. Rows leave their Call or Text to
 * the open task's reach card.
 */
export function TaskQueue({ tasks, currentId, now, setting, idPrefix }: TaskQueueProps) {
  const titleId = `${idPrefix}-title`;
  if (tasks === undefined) {
    return (
      <>
        <TasksHeader titleId={titleId} className="min-h-12" />
        <TasksSkeleton rows={4} />
      </>
    );
  }

  const today = businessDateForInstant(now, setting);
  const { end: endOfToday } = businessDayRange(today, setting);
  const groups = groupCloserTasks(tasks, now, endOfToday);
  const total = tasks.reminders.length + tasks.schedulingLinks.length;

  if (total === 0) {
    return (
      <>
        <TasksHeader titleId={titleId} className="min-h-12" />
        <div className="flex flex-col items-start gap-1 px-4 py-5 text-sm">
          <p className="font-semibold">No open tasks.</p>
          <p className="text-muted-foreground">
            Call-backs and links you set from a call land here.
          </p>
          <Link
            href="/workspace/closer"
            className="mt-2 inline-flex min-h-6 items-center rounded-sm font-semibold underline decoration-foreground/40 underline-offset-[3px] outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Back to Today
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <TasksHeader
        titleId={titleId}
        total={total}
        meta={tasks.isPartial ? "Showing the first 50 of each" : undefined}
        className="min-h-12"
      />
      <div className="text-sm">
        {GROUPS.map(({ key, label }) =>
          groups[key].length === 0 ? null : (
            <TaskGroup
              key={key}
              id={`${idPrefix}-${key}`}
              group={key}
              label={label}
              total={groups[key].length}
            >
              {groups[key].map((task) => (
                <TaskRow
                  key={task._id}
                  task={task}
                  group={key}
                  today={today}
                  setting={setting}
                  showAction={false}
                  current={task._id === currentId}
                />
              ))}
            </TaskGroup>
          ),
        )}
      </div>
    </>
  );
}

/**
 * Below lg the queue is one compact control above the task, opening the
 * same list in a sheet, so the task itself comes first.
 */
export function TaskQueueSheet(props: Omit<TaskQueueProps, "idPrefix">) {
  const [open, setOpen] = useState(false);
  const { tasks, currentId } = props;
  const others =
    tasks === undefined
      ? null
      : [...tasks.reminders, ...tasks.schedulingLinks].filter((task) => task._id !== currentId)
          .length;
  const label =
    others === null
      ? "Tasks"
      : others === 0
        ? "No other tasks"
        : `${others} more ${others === 1 ? "task" : "tasks"}`;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="self-start lg:hidden">
          <ListTodoIcon data-icon="inline-start" aria-hidden />
          {label}
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[min(340px,90vw)] gap-0 p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>Your tasks</SheetTitle>
          <SheetDescription>Open tasks, the one open here marked.</SheetDescription>
        </SheetHeader>
        {/* A row is a link; picking one closes the sheet. */}
        <div
          className="overflow-y-auto [&_header]:pr-12"
          onClickCapture={(event) => {
            if ((event.target as HTMLElement).closest("a")) setOpen(false);
          }}
        >
          <TaskQueue {...props} idPrefix="sheet-tasks" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
