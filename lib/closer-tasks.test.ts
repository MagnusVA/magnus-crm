import { describe, expect, it } from "vitest";
import {
  formatPastDue,
  groupCloserTasks,
  nextReminderId,
  taskTiming,
  type QueueTask,
} from "./closer-tasks";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 29, 15, 0);
const END_OF_TODAY = Date.UTC(2026, 9, 30, 5, 0);

function reminder(id: string, due: number | null, extra: Partial<QueueTask> = {}): QueueTask {
  return {
    _id: id,
    type: "manual_reminder",
    reason: "closer_initiated",
    reminderScheduledAt: due,
    createdAt: NOW - 2 * HOUR,
    ...extra,
  };
}

function link(id: string, createdAt: number): QueueTask {
  return {
    _id: id,
    type: "scheduling_link",
    reason: "closer_initiated",
    reminderScheduledAt: null,
    createdAt,
  };
}

describe("groupCloserTasks", () => {
  it("splits reminders into overdue, today and later, and lists links newest first", () => {
    const groups = groupCloserTasks(
      {
        reminders: [
          reminder("tomorrow", END_OF_TODAY + HOUR),
          reminder("late", NOW - HOUR),
          reminder("tonight", NOW + HOUR),
          reminder("undated", null),
        ],
        schedulingLinks: [link("old", NOW - 3 * HOUR), link("new", NOW - HOUR)],
      },
      NOW,
      END_OF_TODAY,
    );

    expect(groups.overdue.map((task) => task._id)).toEqual(["undated", "late"]);
    expect(groups.today.map((task) => task._id)).toEqual(["tonight"]);
    expect(groups.later.map((task) => task._id)).toEqual(["tomorrow"]);
    expect(groups.waiting.map((task) => task._id)).toEqual(["new", "old"]);
  });
  it("keeps a task in Today for its due minute, as the strip calls it due now", () => {
    const groups = groupCloserTasks(
      { reminders: [reminder("now", NOW - 30_000), reminder("past", NOW - MINUTE)], schedulingLinks: [] },
      NOW,
      END_OF_TODAY,
    );
    expect(groups.today.map((task) => task._id)).toEqual(["now"]);
    expect(groups.overdue.map((task) => task._id)).toEqual(["past"]);
    expect(taskTiming({ status: "pending", reminderScheduledAt: NOW - 30_000 }, NOW).kind).toBe("due_now");
  });
});

describe("nextReminderId", () => {
  const reminders = [
    reminder("later", END_OF_TODAY + HOUR),
    reminder("current", NOW - 2 * HOUR),
    reminder("overdue", NOW - HOUR),
    reminder("nudge", NOW - 3 * HOUR, { reason: "stale_opportunity_nudge" }),
  ];

  it("opens the soonest reminder after the closed one, skipping stale-deal nudges", () => {
    expect(nextReminderId(reminders, { currentId: "current", openedAt: NOW })).toBe("overdue");
  });

  it("skips a reminder created after the page opened", () => {
    const withRetry = [...reminders, reminder("retry", NOW - 5 * HOUR, { createdAt: NOW + MINUTE })];
    expect(nextReminderId(withRetry, { currentId: "current", openedAt: NOW })).toBe("overdue");
  });

  it("returns null when no other reminder is open", () => {
    expect(
      nextReminderId([reminder("current", NOW)], { currentId: "current", openedAt: NOW }),
    ).toBeNull();
  });
});

describe("taskTiming", () => {
  const due = NOW;

  it("is upcoming before the due time, due now within its minute, then overdue", () => {
    expect(taskTiming({ status: "pending", reminderScheduledAt: due }, due - MINUTE)).toEqual({
      kind: "upcoming",
    });
    expect(taskTiming({ status: "pending", reminderScheduledAt: due }, due + 30_000)).toEqual({
      kind: "due_now",
    });
    expect(taskTiming({ status: "pending", reminderScheduledAt: due }, due + 42 * MINUTE)).toEqual({
      kind: "overdue",
      past: "42 min",
    });
  });

  it("is done once the task is no longer pending", () => {
    expect(taskTiming({ status: "completed", reminderScheduledAt: due }, due + HOUR)).toEqual({
      kind: "done",
    });
  });
});

describe("formatPastDue", () => {
  it("rounds down to minutes, hours, then days", () => {
    expect(formatPastDue(30_000)).toBe("1 min");
    expect(formatPastDue(59 * MINUTE)).toBe("59 min");
    expect(formatPastDue(3 * HOUR + 20 * MINUTE)).toBe("3 h");
    expect(formatPastDue(25 * HOUR)).toBe("1 day");
    expect(formatPastDue(50 * HOUR)).toBe("2 days");
  });
});
