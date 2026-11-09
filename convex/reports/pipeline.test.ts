import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import aggregate from "@convex-dev/aggregate/test";
import { meetingsByStatus } from "../reporting/aggregates";
import { api } from "../_generated/api";
import {
  callsReportFixture,
  from,
  identity,
  now,
  DAY,
} from "../../tests/callsReportFixtures";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
describe("Pipeline now", () => {
  it("counts more than 500 owed calls exactly and checks recent durations", async () => {
    const f = await callsReportFixture();
    aggregate.register(f.t, "meetingsByStatus");
    await f.t.run(async (ctx) => {
      const base = (await ctx.db.get("meetings", f.owed))!;
      const { _id, _creationTime, ...doc } = base;
      void _id;
      void _creationTime;
      for (let index = 0; index < 600; index++)
        await ctx.db.insert("meetings", {
          ...doc,
          scheduledAt: from - DAY + index * 60_000,
          assignedCloserId: [f.ana, f.beto, f.inactive, f.former][index % 4],
          callClassification:
            index % 3 === 0 ? undefined : index % 3 === 1 ? "new" : "follow_up",
        });
      for (const [minutesAgo, durationMinutes] of [
        [180, 180],
        [120, 60],
        [120, 180],
        [30, 30],
        [29, 30],
      ]) {
        await ctx.db.insert("meetings", {
          ...doc,
          scheduledAt: now - minutesAgo * 60_000,
          durationMinutes,
        });
      }
    });
    const ids = await f.t.run(async (ctx) =>
      (await ctx.db.query("meetings").take(1000)).map((m) => m._id),
    );
    for (let start = 0; start < ids.length; start += 100)
      await f.t.run(async (ctx) => {
        for (const id of ids.slice(start, start + 100))
          await meetingsByStatus.insert(
            ctx,
            (await ctx.db.get("meetings", id))!,
          );
      });
    const answer = await f.t
      .withIdentity(identity)
      .query(api.reports.pipeline.getPipelineNow, {});
    // 600 seeded old calls, one existing old call, and three recent due calls.
    expect(answer.owed.total).toBe(604);
    expect(answer.owed.calls).toHaveLength(100);
    expect(answer.owed.partial).toBe(true);
  });
  it("does not present a capped scan as an exact total when the aggregate is inconsistent", async () => {
    const f = await callsReportFixture();
    aggregate.register(f.t, "meetingsByStatus");
    await f.t.run(async (ctx) => {
      const base = (await ctx.db.get("meetings", f.owed))!;
      const { _id, _creationTime, ...doc } = base;
      void _id;
      void _creationTime;
      // Simulate an unbackfilled aggregate. The source rows are present.
      for (let index = 0; index < 501; index++)
        await ctx.db.insert("meetings", {
          ...doc,
          scheduledAt: from - DAY + index * 60_000,
        });
    });
    const answer = await f.t
      .withIdentity(identity)
      .query(api.reports.pipeline.getPipelineNow, {});
    expect(answer.owed.total).toBeNull();
    expect(answer.owed.partial).toBe(true);
  });
  it("reads all-time owed calls and present open deals, tasks and ages", async () => {
    const f = await callsReportFixture();
    const oldOwed = await f.t.run(async (ctx) => {
      const leadId = (await ctx.db.get("opportunities", f.owedDeal))!.leadId;
      await ctx.db.insert("followUps", {
        tenantId: f.tenantId,
        opportunityId: f.owedDeal,
        leadId,
        closerId: f.beto,
        type: "manual_reminder",
        status: "pending",
        reason: "admin_initiated",
        reminderScheduledAt: now - DAY,
        createdAt: from,
      });
      await ctx.db.patch("opportunities", f.rebookDeal, {
        nextMeetingAt: now + DAY,
      });
      const m = (await ctx.db.get("meetings", f.owed))!;
      const { _id, _creationTime, ...doc } = m;
      void _id;
      void _creationTime;
      return await ctx.db.insert("meetings", {
        ...doc,
        scheduledAt: from - 2 * DAY,
      });
    });
    const answer = await f.t
      .withIdentity(identity)
      .query(api.reports.pipeline.getPipelineNow, {});
    expect(answer.stages.find((s) => s.stage === "follow_up")).toMatchObject({
      count: 2,
      medianAgeDays: 6,
      oldestAgeDays: 6,
      partial: false,
    });
    expect(answer.noNextStep).toEqual({ count: 0, partial: false });
    expect(answer.overdueTasks).toEqual({ count: 1, partial: false });
    expect(answer.owed.total).toBe(2);
    expect(answer.owed.calls.map((c) => c.meetingId)).toEqual([
      oldOwed,
      f.owed,
    ]);
    expect(answer.aging.deals).toHaveLength(2);
    expect(
      answer.aging.deals.find((d) => d.opportunityId === f.owedDeal)?.nextStep
        ?.kind,
    ).toBe("task");
    expect(answer.bookingReviews).toEqual({
      count: 0,
      oldest: null,
      partial: false,
    });
  });
  it("marks stage medians unknown and list totals partial when the bound is reached", async () => {
    const f = await callsReportFixture();
    await f.t.run(async (ctx) => {
      const original = (await ctx.db.get("opportunities", f.owedDeal))!;
      const { _id: ignoredId, _creationTime: ignoredTime, ...doc } = original;
      void ignoredId;
      void ignoredTime;
      for (let i = 0; i < 126; i++)
        await ctx.db.insert("opportunities", {
          ...doc,
          stage: "qualified",
          createdAt: from - (10 + i) * DAY,
        });
    });
    const answer = await f.t
      .withIdentity(identity)
      .query(api.reports.pipeline.getPipelineNow, {});
    expect(answer.stages.find((s) => s.stage === "qualified")).toMatchObject({
      medianAgeDays: null,
      partial: true,
    });
    expect(answer.stages.find((s) => s.stage === "follow_up")).toMatchObject({
      count: 2,
      medianAgeDays: 6,
      partial: false,
    });
    expect(answer.noNextStep.partial).toBe(true);
    expect(answer.aging.deals).toHaveLength(50);
    expect(answer.aging.partial).toBe(true);
    await expect(
      f.t
        .withIdentity({ subject: "reports_ana", org_id: identity.org_id })
        .query(api.reports.pipeline.getPipelineNow, {}),
    ).rejects.toThrow("Insufficient permissions");
  });
});
