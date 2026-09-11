import { describe, expect, it } from "vitest";
import { collectDashboardPages } from "./dashboard-pages";

describe("dashboard result transport", () => {
  it("assembles every bounded page, including empty byte-limited pages", async () => {
    const cursors: (string | null)[] = [];
    const rows = await collectDashboardPages(async (cursor) => {
      cursors.push(cursor);
      if (cursor === null) return { page: [1, 2], isDone: false, continueCursor: "a" };
      if (cursor === "a") return { page: [], isDone: false, continueCursor: "b" };
      return { page: [3], isDone: true, continueCursor: "end" };
    }, () => false);
    expect(rows).toEqual([1, 2, 3]);
    expect(cursors).toEqual([null, "a", "b"]);
  });

  it("discards an obsolete range without requesting its remaining pages", async () => {
    let canceled = false;
    let calls = 0;
    const rows = await collectDashboardPages(async () => {
      calls++;
      canceled = true;
      return { page: [1], isDone: false, continueCursor: "next" };
    }, () => canceled);
    expect(rows).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("rejects a stalled cursor instead of showing a partial dashboard", async () => {
    await expect(collectDashboardPages(async () => ({ page: [], isDone: false, continueCursor: "same" }), () => false)).rejects.toThrow("progress");
  });
});
