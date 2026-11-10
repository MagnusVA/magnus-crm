import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool } from "../../../tests/mcpHarness";
import { mcpToolsFixture } from "../../../tests/mcpToolsFixtures";
import { localDateKey } from "../time";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const tomorrow = () => localDateKey(Date.now() + 36 * 60 * 60 * 1000, "America/Tegucigalpa");

describe("magnus_move_callback", () => {
  it("moves the closer's pending call-back in their zone and records the move", async () => {
    const f = await mcpToolsFixture();
    const date = tomorrow();
    const result = await callTool(f.t, f.token, f.sessionId, "magnus_move_callback", { taskId: f.taskId, date, time: "16:00" });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ moved: true });
    expect((result.data as { due: string }).due).toMatch(/4:00 PM CST/);
    const task = await f.t.run((ctx) => ctx.db.get("followUps", f.taskId));
    expect(task?.status).toBe("pending");
    const events = await f.t.run((ctx) =>
      ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
          q.eq("tenantId", f.tenantId).eq("entityType", "followUp").eq("entityId", f.taskId),
        )
        .take(10),
    );
    expect(events.map((event) => event.eventType)).toContain("followUp.rescheduled");
  });

  it("refuses another closer's call-back and a time in the past", async () => {
    const f = await mcpToolsFixture();
    const other = await callTool(f.t, f.token, f.sessionId, "magnus_move_callback", {
      taskId: f.otherTaskId,
      date: tomorrow(),
      time: "16:00",
    });
    expect(other.text ?? "").toContain("isn't one of your call-backs");
    const past = await callTool(f.t, f.token, f.sessionId, "magnus_move_callback", {
      taskId: f.taskId,
      date: "2020-01-01",
      time: "09:00",
    });
    expect(past.text ?? "").toContain("future");
    const bad = await callTool(f.t, f.token, f.sessionId, "magnus_move_callback", {
      taskId: f.taskId,
      date: "tomorrow",
      time: "4pm",
    });
    expect(bad.text ?? "").toContain("YYYY-MM-DD");
  });
});
