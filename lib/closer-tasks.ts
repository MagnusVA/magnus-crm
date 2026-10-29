/**
 * The closer's open tasks as Today's Tasks card and the task page's queue
 * list them (`getCloserTasks`): reminders by when they are due, and
 * scheduling links waiting on the person to book.
 */

/** The fields the lists group and order by. */
export type QueueTask = {
  _id: string;
  type: "manual_reminder" | "scheduling_link";
  reason: string;
  reminderScheduledAt: number | null;
  createdAt: number;
};

export type TaskGroupKey = "overdue" | "today" | "later" | "waiting";

/** A task is "due now" for the minute it falls due, and overdue after it. */
const DUE_NOW_MS = 60_000;

/**
 * Reminders past due (past their due minute, as `taskTiming` says), due
 * later today (`endOfToday` is the business day's end), and due after today,
 * soonest first; then scheduling links, newest
 * first. A reminder with no due time counts as overdue.
 */
export function groupCloserTasks<T extends QueueTask>(
  tasks: { reminders: T[]; schedulingLinks: T[] },
  now: number,
  endOfToday: number,
): Record<TaskGroupKey, T[]> {
  const dueAt = (task: T) => task.reminderScheduledAt ?? 0;
  const reminders = [...tasks.reminders].sort((a, b) => dueAt(a) - dueAt(b));
  return {
    overdue: reminders.filter((task) => dueAt(task) + DUE_NOW_MS <= now),
    today: reminders.filter(
      (task) => dueAt(task) + DUE_NOW_MS > now && dueAt(task) < endOfToday,
    ),
    later: reminders.filter((task) => dueAt(task) >= endOfToday),
    waiting: [...tasks.schedulingLinks].sort((a, b) => b.createdAt - a.createdAt),
  };
}

/**
 * A task the queue opens on its task page: a call-back or text-back
 * reminder, or a scheduling link waiting on a booking. A stale-deal nudge
 * opens the deal instead, where it is resolved.
 */
export function opensTaskPage(task: QueueTask): boolean {
  return task.reason !== "stale_opportunity_nudge";
}

/**
 * The task to open after an outcome closes a reminder (`currentId`): the next
 * reminder in queue order (Overdue, Today, then Later, which is soonest due
 * first), or null when none is left. Never a scheduling link: a call-back
 * session moves through call-backs. A reminder created after `openedAt` is
 * skipped, so the one a "Try again" just set doesn't open straight away.
 */
export function nextReminderId<T extends QueueTask>(
  reminders: T[],
  { currentId, openedAt }: { currentId: string; openedAt: number },
): T["_id"] | null {
  const next = [...reminders]
    .filter(
      (task) =>
        task.type === "manual_reminder" &&
        opensTaskPage(task) &&
        task._id !== currentId &&
        task.createdAt <= openedAt,
    )
    .sort((a, b) => (a.reminderScheduledAt ?? 0) - (b.reminderScheduledAt ?? 0))[0];
  return next?._id ?? null;
}

/**
 * The task to open after a scheduling-link task closes (`currentId`): the
 * next task in queue order, reminders first (as `nextReminderId`), then the
 * links waiting on the person, newest first as the queue lists them. Null
 * when none is left, and the page goes back to Today.
 */
export function nextTaskId<T extends QueueTask>(
  tasks: { reminders: T[]; schedulingLinks: T[] },
  { currentId, openedAt }: { currentId: string; openedAt: number },
): T["_id"] | null {
  const reminder = nextReminderId(tasks.reminders, { currentId, openedAt });
  if (reminder !== null) return reminder;
  const link = [...tasks.schedulingLinks]
    .filter(
      (task) =>
        task.type === "scheduling_link" &&
        task._id !== currentId &&
        task.createdAt <= openedAt,
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return link?._id ?? null;
}

export type TaskTiming =
  | { kind: "upcoming" }
  /** Within the minute it is due. */
  | { kind: "due_now" }
  | { kind: "overdue"; past: string }
  | { kind: "done" };

/** Where a task stands against its due time, for the strip's status word. */
export function taskTiming(
  task: { status: string; reminderScheduledAt?: number | null },
  now: number,
): TaskTiming {
  if (task.status !== "pending") return { kind: "done" };
  const due = task.reminderScheduledAt ?? null;
  if (due === null || now < due) return { kind: "upcoming" };
  if (now < due + DUE_NOW_MS) return { kind: "due_now" };
  return { kind: "overdue", past: formatPastDue(now - due) };
}

/** "42 min", "3 h", "2 days": how long past due, rounded down. */
export function formatPastDue(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}
