import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import {
  callsReportFixture,
  from,
  identity,
  now,
  to,
} from "../../tests/callsReportFixtures";
import { buildCallsSummary } from "./calls";
import { loadCallFacts, callState } from "./lib/callFacts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
describe("Calls facts and builder", () => {
  it("keeps moved slots separate, detects no-show rebooks and preserves historical hosts", async () => {
    const f = await callsReportFixture();
    const answer = await f.t
      .withIdentity(identity)
      .query(api.reports.calls.getCallsSummary, {
        startDate: from,
        endDate: to,
      });
    expect(answer.counts).toEqual({
      scheduled: 7,
      moved: 1,
      canceled: 1,
      upcoming: 0,
      due: 6,
      held: 4,
      noShow: 1,
      notRecorded: 1,
      rebooked: 1,
      rebookedHeld: 1,
      rebookedNoShow: 0,
    });
    expect(answer.noShowMarkers).toEqual({
      closer: 0,
      admin: 1,
      calendly: 0,
      unknown: 0,
    });
    expect(answer.noShowReasons).toEqual([{ reason: "no_response", count: 1 }]);
    expect(answer.mode.standard.held).toBe(4);
    expect(answer.recordMinutes).toEqual([5, 3, 5]);
    const ana = await f.t
      .withIdentity(identity)
      .query(api.reports.calls.getCallsSummary, {
        startDate: from,
        endDate: to,
        closerId: f.ana,
      });
    expect(ana.counts.held).toBe(1);
    expect(ana.counts.noShow).toBe(1);
    const beto = await f.t
      .withIdentity(identity)
      .query(api.reports.calls.getCallsSummary, {
        startDate: from,
        endDate: to,
        closerId: f.beto,
        callType: "follow_up",
      });
    expect(beto.counts.held).toBe(2);
  });
  it("changes scheduled to not recorded at the end of the call, including equality", async () => {
    const f = await callsReportFixture();
    await f.t.run(async (ctx) => {
      const meeting = (await ctx.db.get("meetings", f.owed))!;
      const evidence = { closerId: f.beto, moved: false, rebooked: false };
      const end = meeting.scheduledAt + meeting.durationMinutes * 60_000;
      expect(callState(meeting, evidence, end - 1)).toMatchObject({
        due: false,
        status: "upcoming",
      });
      expect(callState(meeting, evidence, end)).toMatchObject({
        due: true,
        status: "not_recorded",
      });
      expect(
        callState({ ...meeting, status: "canceled" }, evidence, end),
      ).toMatchObject({ due: false, status: "canceled" });
      expect(
        callState(meeting, { ...evidence, moved: true }, end),
      ).toMatchObject({ due: false, status: "moved" });
    });
  });
  it.each(["held", "no_show"] as const)("counts an early %s result as due in Calls and the member report", async (status) => {
    const f = await callsReportFixture();
    const scheduledAt = await f.t.run(async (ctx) => {
      const meeting = (await ctx.db.get("meetings", f.hostChanged))!;
      await ctx.db.patch("meetings", meeting._id, { status });
      return meeting.scheduledAt;
    });
    const args = { startDate: scheduledAt, endDate: scheduledAt + 1, asOf: scheduledAt + 60_000 };
    const reader = f.t.withIdentity(identity);
    const calls = await reader.query(api.reports.calls.getCallsSummary, args);
    expect(calls.counts).toMatchObject({ due: 1, held: status === "held" ? 1 : 0, noShow: status === "no_show" ? 1 : 0, notRecorded: 0 });
    expect((calls.counts.held + calls.counts.noShow) / calls.counts.due).toBe(1);
    const member = await reader.query(api.reports.people.getPeopleClosers, { ...args, memberId: f.memberA });
    expect(member.rows[0]).toMatchObject({ due: 1, held: calls.counts.held, noShow: calls.counts.noShow, notRecorded: 0 });
  });
  it("advances the live due boundary when the page clock changes", async () => {
    const f = await callsReportFixture();
    const end = await f.t.run(async (ctx) => {
      const m = (await ctx.db.get("meetings", f.owed))!;
      return m.scheduledAt + m.durationMinutes * 60_000;
    });
    const reader = f.t.withIdentity(identity);
    const args = { startDate: from, endDate: to };
    const before = await reader.query(api.reports.calls.getCallsSummary, {
      ...args,
      asOf: end - 1,
    });
    const after = await reader.query(api.reports.calls.getCallsSummary, {
      ...args,
      asOf: end,
    });
    expect(before.counts.notRecorded).toBe(0);
    expect(after.counts.notRecorded).toBe(1);
    expect(after.counts.upcoming).toBe(before.counts.upcoming - 1);
    const peopleBefore = await reader.query(
      api.reports.people.getPeopleClosers,
      { ...args, memberId: f.memberB, asOf: end - 1 },
    );
    const peopleAfter = await reader.query(
      api.reports.people.getPeopleClosers,
      { ...args, memberId: f.memberB, asOf: end },
    );
    expect(peopleAfter.rows[0].notRecorded).toBe(
      peopleBefore.rows[0].notRecorded + 1,
    );
    const pipelineBefore = await reader.query(
      api.reports.pipeline.getPipelineNow,
      { asOf: end - 1 },
    );
    const pipelineAfter = await reader.query(
      api.reports.pipeline.getPipelineNow,
      { asOf: end },
    );
    expect(pipelineAfter.owed.total).toBe(pipelineBefore.owed.total! + 1);
  });
  it("returns the oldest 200 owed calls and keeps their full count", async () => {
    const f = await callsReportFixture();
    await f.t.run(async (ctx) => {
      const m = (await ctx.db.get("meetings", f.owed))!;
      const fact = (await loadCallFacts(ctx, f.tenantId, [m], now)).facts[0];
      const facts = Array.from({ length: 205 }, (_, index) => ({
        ...fact,
        meeting: { ...m, scheduledAt: from + index * 60_000 },
      }));
      const answer = buildCallsSummary(
        { facts, partial: true },
        {},
        await getTenantBusinessDay(ctx, f.tenantId),
      );
      expect(answer.owed).toHaveLength(200);
      expect(answer.owedTotal).toBe(205);
      expect(answer.partial).toBe(true);
      expect(answer.owed[0].scheduledAt).toBe(from);
      expect(answer.owed[199].scheduledAt).toBe(from + 199 * 60_000);
    });
  });
  it("scopes the booking program and rejects members", async () => {
    const f = await callsReportFixture();
    await expect(
      f.t
        .withIdentity({ subject: "reports_ana", org_id: identity.org_id })
        .query(api.reports.calls.getCallsSummary, {
          startDate: from,
          endDate: to,
        }),
    ).rejects.toThrow("Insufficient permissions");
    const answer = await f.t
      .withIdentity(identity)
      .query(api.reports.calls.getCallsSummary, {
        startDate: from,
        endDate: to,
        programId: f.programId,
      });
    expect(
      answer.byDay.every(
        (d) => d.dayKey >= "2026-09-01" && d.dayKey <= "2026-09-04",
      ),
    ).toBe(true);
    expect(answer.leadTime.find((b) => b.bucket === "2_3_days")?.held).toBe(1);
  });
});
