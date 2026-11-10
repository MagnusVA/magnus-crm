import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import aggregate from "@convex-dev/aggregate/test";
import type { FunctionReturnType } from "convex/server";
import { meetingsByStatus } from "../reporting/aggregates";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { OPEN_PIPELINE_STAGES } from "../reporting/pipelineHealth";
import { pipelineNextStep } from "./lib/pipelineNextStep";
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
  it("counts owed calls exactly when a closer's user record is gone", async () => {
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
        });
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
    // Production holds meetings whose closer's user was deleted; reading
    // closers from users made the aggregate check fail every time.
    await f.t.run(async (ctx) => ctx.db.delete("users", f.former));
    const answer = await f.t
      .withIdentity(identity)
      .query(api.reports.pipeline.getPipelineNow, {});
    expect(answer.owed.total).toBe(601);
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

describe("Pipeline pages", () => {
  it("pages 25 mixed-stage open deals oldest first without gaps or duplicates", async () => {
    const f = await callsReportFixture();
    const expected = await f.t.run(async (ctx) => {
      const original = (await ctx.db.get("opportunities", f.owedDeal))!;
      const { _id, _creationTime, ...doc } = original;
      void _id;
      void _creationTime;
      for (let index = 0; index < 23; index++)
        await ctx.db.insert("opportunities", {
          ...doc,
          stage: OPEN_PIPELINE_STAGES[index % OPEN_PIPELINE_STAGES.length],
          // Insert out of order, with ties across stages and page boundaries.
          createdAt: from - Math.floor(((index * 7) % 23) / 3) * DAY,
        });
      await ctx.db.patch("opportunities", f.owedDeal, {
        nextMeetingAt: now + DAY,
      });
      await ctx.db.insert("followUps", {
        tenantId: f.tenantId,
        opportunityId: f.owedDeal,
        leadId: doc.leadId,
        closerId: f.beto,
        type: "manual_reminder",
        status: "pending",
        reason: "admin_initiated",
        reminderScheduledAt: now + 2 * DAY,
        createdAt: from,
      });
      return (await ctx.db.query("opportunities").take(100))
        .filter((deal) => deal.outcome === "open")
        .sort(
          (a, b) =>
            a.createdAt - b.createdAt ||
            a._creationTime - b._creationTime ||
            a._id.localeCompare(b._id),
        );
    });
    const viewer = f.t.withIdentity(identity);
    const pages = [];
    let cursor: string | null = null;
    for (let index = 0; index < 3; index++) {
      const page: FunctionReturnType<typeof api.reports.pipeline.listOpenDeals> =
        await viewer.query(api.reports.pipeline.listOpenDeals, {
          paginationOpts: { numItems: 10, cursor },
        });
      pages.push(page);
      cursor = page.continueCursor;
    }
    expect(pages.map((page) => page.page.length)).toEqual([10, 10, 5]);
    expect(pages.map((page) => page.isDone)).toEqual([false, false, true]);
    const rows = pages.flatMap((page) => page.page);
    expect(rows.map((row) => row.opportunityId)).toEqual(
      expected.map((deal) => deal._id),
    );
    expect(new Set(rows.map((row) => row.opportunityId)).size).toBe(25);
    expect(rows.find((row) => row.opportunityId === f.owedDeal)).toEqual({
      opportunityId: f.owedDeal,
      stage: "follow_up",
      createdAt: from - DAY,
      leadName: "Person",
      closerName: "Beto",
      nextMeetingAt: now + DAY,
      task: { at: now + 2 * DAY },
    });
  });

  it("excludes won and lost deals", async () => {
    const f = await callsReportFixture();
    const lost = await f.t.run(async (ctx) => {
      const original = (await ctx.db.get("opportunities", f.won))!;
      const { _id, _creationTime, ...doc } = original;
      void _id;
      void _creationTime;
      return await ctx.db.insert("opportunities", { ...doc, outcome: "lost" });
    });
    const answer = await f.t.withIdentity(identity).query(
      api.reports.pipeline.listOpenDeals,
      { paginationOpts: { numItems: 100, cursor: null } },
    );
    const ids = answer.page.map((row) => row.opportunityId);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(f.won);
    expect(ids).not.toContain(f.old);
    expect(ids).not.toContain(lost);
  });

  it("isolates both pages and joined names and tasks from another tenant", async () => {
    const f = await callsReportFixture();
    const other = await f.t.run(async (ctx) => {
      const tenant = (await ctx.db.get("tenants", f.tenantId))!;
      const { _id, _creationTime, ...tenantDoc } = tenant;
      void _id;
      void _creationTime;
      const tenantId = await ctx.db.insert("tenants", {
        ...tenantDoc,
        workosOrgId: "org_other_pipeline",
      });
      const closerId = await ctx.db.insert("users", {
        tenantId,
        workosUserId: "other_pipeline_closer",
        role: "closer",
        fullName: "Private closer",
        email: "private@example.invalid",
        isActive: true,
      });
      const original = (await ctx.db.get("opportunities", f.owedDeal))!;
      const { _id: dealId, _creationTime: dealTime, ...deal } = original;
      void dealId;
      void dealTime;
      const originalLead = (await ctx.db.get("leads", deal.leadId))!;
      const { _id: personId, _creationTime: personTime, ...person } = originalLead;
      void personId;
      void personTime;
      const leadId = await ctx.db.insert("leads", {
        ...person,
        tenantId,
        fullName: "Private person",
      });
      const opportunityId = await ctx.db.insert("opportunities", {
        ...deal,
        tenantId,
        leadId,
        assignedCloserId: closerId,
      });
      const originalMeeting = (await ctx.db.get("meetings", f.owed))!;
      const {
        _id: meetingId,
        _creationTime: meetingTime,
        ...meeting
      } = originalMeeting;
      void meetingId;
      void meetingTime;
      const callId = await ctx.db.insert("meetings", {
        ...meeting,
        tenantId,
        opportunityId,
        assignedCloserId: closerId,
        scheduledAt: from - DAY,
      });
      // Stale foreign references must not leak their names or task time.
      await ctx.db.patch("opportunities", f.owedDeal, {
        leadId,
        assignedCloserId: closerId,
      });
      await ctx.db.insert("followUps", {
        tenantId,
        opportunityId: f.owedDeal,
        leadId,
        closerId,
        type: "manual_reminder",
        status: "pending",
        reason: "admin_initiated",
        reminderScheduledAt: now,
        createdAt: from,
      });
      return { opportunityId, callId };
    });
    const viewer = f.t.withIdentity(identity);
    const deals = await viewer.query(api.reports.pipeline.listOpenDeals, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(deals.page.map((row) => row.opportunityId)).not.toContain(
      other.opportunityId,
    );
    expect(deals.page).toHaveLength(2);
    expect(
      deals.page.find((row) => row.opportunityId === f.owedDeal),
    ).toMatchObject({
      leadName: "Unknown person",
      closerName: null,
      task: null,
    });
    const calls = await viewer.query(api.reports.pipeline.listOwedCalls, {
      endedBy: now,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(calls.page.map((row) => row.meetingId)).toEqual([f.owed]);
    expect(calls.page.map((row) => row.meetingId)).not.toContain(other.callId);
  });

  it("fills an owed-call page after skipping a call that has started but not ended", async () => {
    const f = await callsReportFixture();
    const endedBy = from + 3 * 3_600_000;
    const seeded = await f.t.run(async (ctx) => {
      const original = (await ctx.db.get("meetings", f.owed))!;
      const { _id, _creationTime, ...doc } = original;
      void _id;
      void _creationTime;
      const started = await ctx.db.insert("meetings", {
        ...doc,
        scheduledAt: endedBy - 90 * 60_000,
        durationMinutes: 120,
      });
      const ended: Id<"meetings">[] = [];
      for (let index = 0; index < 10; index++)
        ended.push(
          await ctx.db.insert("meetings", {
            ...doc,
            scheduledAt: endedBy - (60 - index) * 60_000,
            durationMinutes: 1,
          }),
        );
      return { started, ended };
    });
    const answer = await f.t.withIdentity(identity).query(
      api.reports.pipeline.listOwedCalls,
      { endedBy, paginationOpts: { numItems: 10, cursor: null } },
    );
    expect(answer.page).toHaveLength(10);
    expect(answer.page.map((row) => row.meetingId)).toEqual(seeded.ended);
    expect(answer.page.map((row) => row.meetingId)).not.toContain(seeded.started);
    expect(answer.page[0]).toEqual({
      meetingId: seeded.ended[0],
      opportunityId: f.owedDeal,
      scheduledAt: endedBy - 60 * 60_000,
      endsAt: endedBy - 59 * 60_000,
      closerId: f.beto,
      closerName: "Beto",
      leadName: "Person",
    });
  });

  it("keeps an owed call whose credit history is too long to read", async () => {
    const f = await callsReportFixture();
    await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...credit } = (await ctx.db.query("dealAttributions").first())!;
      void _id;
      void _creationTime;
      // One row past what the enrichment reads for a call.
      for (let index = 0; index < 101; index++)
        await ctx.db.insert("dealAttributions", {
          ...credit,
          meetingId: f.owed,
          opportunityId: f.owedDeal,
          attributedAt: index,
          createdAt: index,
        });
    });
    const answer = await f.t.withIdentity(identity).query(api.reports.pipeline.listOwedCalls, {
      endedBy: now,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(answer.page).toMatchObject([{ meetingId: f.owed, closerId: f.beto, closerName: "Beto", leadName: "Person" }]);
  });

  it("removes a call from the owed page when it is marked held", async () => {
    const f = await callsReportFixture();
    const viewer = f.t.withIdentity(identity);
    const args = { endedBy: now, paginationOpts: { numItems: 10, cursor: null } };
    const before = await viewer.query(api.reports.pipeline.listOwedCalls, args);
    expect(before.page.map((row) => row.meetingId)).toEqual([f.owed]);
    await f.t.run(async (ctx) => {
      await ctx.db.patch("meetings", f.owed, { status: "held", heldMarkedAt: now });
    });
    const after = await viewer.query(api.reports.pipeline.listOwedCalls, args);
    expect(after.page).toEqual([]);
    expect(after.isDone).toBe(true);
  });

  it("rejects a closer for both admin-only pages", async () => {
    const f = await callsReportFixture();
    const viewer = f.t.withIdentity({
      subject: "reports_ana",
      org_id: identity.org_id,
    });
    await expect(
      viewer.query(api.reports.pipeline.listOpenDeals, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow("Insufficient permissions");
    await expect(
      viewer.query(api.reports.pipeline.listOwedCalls, {
        endedBy: now,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow("Insufficient permissions");
  });
});

describe("pipelineNextStep", () => {
  it("chooses a future call, otherwise a task, otherwise no next step", () => {
    expect(
      pipelineNextStep({ nextMeetingAt: now, task: { at: now } }, now),
    ).toEqual({ kind: "call", at: now });
    expect(
      pipelineNextStep({ nextMeetingAt: now + DAY, task: { at: now } }, now),
    ).toEqual({ kind: "task", at: now });
    expect(
      pipelineNextStep({ nextMeetingAt: now - 1, task: { at: null } }, now),
    ).toEqual({ kind: "task", at: null });
    expect(
      pipelineNextStep({ nextMeetingAt: undefined, task: null }, now),
    ).toBeNull();
    expect(
      pipelineNextStep({ nextMeetingAt: null, task: null }, now),
    ).toBeNull();
  });
});
