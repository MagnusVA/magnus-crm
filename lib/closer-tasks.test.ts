import { describe, expect, it } from "vitest";
import {
  formatPastDue,
  groupCloserTasks,
  nextReminderId,
  nextTaskId,
  opensTaskPage,
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

describe("opensTaskPage", () => {
  it("opens reminders and scheduling links on the task page, and a stale-deal nudge on the deal", () => {
    expect(opensTaskPage(reminder("call", NOW))).toBe(true);
    expect(opensTaskPage(link("link", NOW))).toBe(true);
    expect(opensTaskPage(reminder("nudge", NOW, { reason: "stale_opportunity_nudge" }))).toBe(false);
  });
});

describe("nextReminderId never opens a link", () => {
  it("skips scheduling links even when they are handed in with the reminders", () => {
    expect(
      nextReminderId([reminder("current", NOW), link("link", NOW - HOUR)], {
        currentId: "current",
        openedAt: NOW,
      }),
    ).toBeNull();
  });
});

describe("nextTaskId", () => {
  const tasks = {
    reminders: [reminder("later", END_OF_TODAY + HOUR), reminder("overdue", NOW - HOUR)],
    schedulingLinks: [link("old", NOW - 3 * HOUR), link("current", NOW - 2 * HOUR), link("new", NOW - HOUR)],
  };

  it("opens the next reminder first, in queue order", () => {
    expect(nextTaskId(tasks, { currentId: "current", openedAt: NOW })).toBe("overdue");
  });

  it("then the newest other link, as the queue lists them", () => {
    expect(
      nextTaskId({ ...tasks, reminders: [] }, { currentId: "current", openedAt: NOW }),
    ).toBe("new");
  });

  it("skips a link sent after the page opened, and returns null when nothing is left", () => {
    expect(
      nextTaskId(
        { reminders: [], schedulingLinks: [link("current", NOW - HOUR), link("fresh", NOW + MINUTE)] },
        { currentId: "current", openedAt: NOW },
      ),
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
