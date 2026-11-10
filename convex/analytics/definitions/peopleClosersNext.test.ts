import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { buildPeopleClosers, type PeopleClosers } from "../../reports/people";
import { callState, type CallFact } from "../../reports/lib/callFacts";
import { expectSameAnswer } from "../../../tests/analyticsParity";
import { closerAggregateRows } from "../../../tests/peopleClosersAggregateFixtures";
import { callsReportFixture, DAY, from, identity, now, range, to } from "../../../tests/callsReportFixtures";
import { callEvidenceJoinsSql, callFactsSql } from "./calls";
import { peopleClosers } from "./people";
import { peopleClosersNext } from "./peopleClosersNext";
import { getReportDefinition, listReportDefinitions } from "../registry";
import { REPORT_PANELS } from "../../mcp/reports/catalog";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe("People closers aggregate candidate", () => {
  it("keeps calls.summary's exact SQL and hides the shadow from page, assistant and ordinary enumeration", () => {
    // Captured before exporting the shared fragment, so formatting changes fail too.
    expect(createHash("sha256").update(callFactsSql).digest("hex")).toBe("da7d3c8a62bb99b69a4b1adb8a6ff1f4159e1bdf7558a44e334233b02a8ab970");
    expect(callFactsSql).toContain(callEvidenceJoinsSql);
    expect(peopleClosers.sql({ tenantId: "test" as Id<"tenants">, filters: { memberId: null }, range }).meetings.sql).toBe(callFactsSql);
    expect(peopleClosersNext.page).toBeNull();
    expect(getReportDefinition("people.closers.next")).toBe(peopleClosersNext);
    expect(listReportDefinitions().some(r => /\.(next|raw)$/.test(r.id))).toBe(false);
    expect(Object.values(REPORT_PANELS).flat()).not.toContain("people.closers.next");
  });
  it("matches the live roster and member answers with signed gaps, payment-only closers, ties and case-sensitive currencies", async () => {
    const f = await callsReportFixture();
    const tiedDeals = await f.t.run(async ctx => {
      await ctx.db.patch("meetings", f.hostChanged, { heldMarkedAt: from + DAY + 28.5 * 60000 });
      await ctx.db.patch("meetings", f.moved, { heldMarkedAt: to + DAY });
      const originalCredit = (await ctx.db.query("dealAttributions").withIndex("by_tenantId_and_meetingId", q => q.eq("tenantId", f.tenantId).eq("meetingId", f.hostChanged)).first())!;
      const { _id: creditId, _creationTime: creditCreated, ...credit } = originalCredit; void creditId; void creditCreated;
      for (const userId of [f.beto, f.ana]) await ctx.db.insert("dealAttributions", { ...credit,
        source: { kind: "booking_closer", userId }, attributedAt: from + 1 });
      const payment = (await ctx.db.get("paymentRecords", f.firstPayment))!;
      const { _id, _creationTime, ...base } = payment; void _id; void _creationTime;
      // Admin has no calls and isn't in the closer roster. Only payment credit includes them.
      await ctx.db.insert("paymentRecords", { ...base, opportunityId: undefined, meetingId: undefined, attributedCloserId: f.admin, currency: "usd" });
      const original = (await ctx.db.get("opportunities", f.won))!;
      const { _id: dealId, _creationTime: created, ...deal } = original; void dealId; void created;
      const tieCreation = await ctx.db.insert("opportunities", deal);
      const tieId = await ctx.db.insert("opportunities", deal);
      vi.setSystemTime(now - 1000);
      const older = await ctx.db.insert("paymentRecords", { ...base, opportunityId: tieCreation, meetingId: undefined,
        attributedCloserId: f.ana, recordedAt: from + DAY, status: "verified", currency: "usd" });
      vi.setSystemTime(now);
      await ctx.db.insert("paymentRecords", { ...base, opportunityId: tieCreation, meetingId: undefined,
        attributedCloserId: f.beto, recordedAt: from + DAY, status: "recorded", currency: "USD" });
      const a = await ctx.db.insert("paymentRecords", { ...base, opportunityId: tieId, meetingId: undefined, attributedCloserId: f.ana, status: "recorded" });
      const b = await ctx.db.insert("paymentRecords", { ...base, opportunityId: tieId, meetingId: undefined, attributedCloserId: f.beto, status: "verified" });
      const aDoc = (await ctx.db.get("paymentRecords", a))!, bDoc = (await ctx.db.get("paymentRecords", b))!;
      expect(aDoc._creationTime).toBeLessThan(bDoc._creationTime);
      // Lifetime linked cash includes payments made after the report window.
      await ctx.db.insert("paymentRecords", { ...base, opportunityId: f.won, meetingId: f.hostChanged,
        attributedCloserId: f.ana, recordedAt: to + DAY, currency: "usd", amountMinor: 123 });
      return { tieCreation, tieId, older, tieWinner: aDoc._creationTime < bDoc._creationTime || a.localeCompare(b) < 0 ? f.ana : f.beto };
    });
    for (const memberId of [null, f.memberA, f.memberB]) {
      const rows = await closerAggregateRows(f.t, f.tenantId, memberId);
      // JSONEachRow can encode Int64 as strings.
      rows.totals.forEach(row => { row.due = String(row.due); row.record_minutes = (row.record_minutes as number[]).map(String); });
      const answer: PeopleClosers = await expectSameAnswer({ t: f.t, identity, tenantId: f.tenantId,
        reportId: "people.closers.next", live: api.reports.people.getPeopleClosers,
        liveArgs: { startDate: from, endDate: to, ...(memberId ? { memberId } : {}) }, filters: { memberId }, range, rows });
      if (!memberId) {
        expect(answer.rows.find(r => r.userId === f.ana)?.recordMinutes).toContain(-1);
        expect(answer.rows.find(r => r.userId === f.beto)?.recordMinutes).not.toContain((to + DAY - from - 2 * 3600000 - 30 * 60000) / 60000);
        expect(answer.rows.find(r => r.userId === f.admin)).toMatchObject({ due: 0, payments: 1, cash: [{ currency: "usd", cashMinor: 2000, finalMinor: 0 }] });
        expect(answer.rows.find(r => r.userId === f.inactive)).toMatchObject({ due: 0, payments: 0, isActive: false });
        expect(answer.rows.find(r => r.userId === f.ana)?.wonDealIds).toContain(tiedDeals.tieCreation);
        expect(answer.rows.find(r => r.userId === tiedDeals.tieWinner)?.wonDealIds).toContain(tiedDeals.tieId);
        expect(answer.rows.find(r => r.userId === f.ana)?.cash.map(c => c.currency)).toEqual(["usd", "USD"]);
        expect(answer.firstPaymentDealIds).toEqual(expect.arrayContaining([f.won, tiedDeals.tieCreation, tiedDeals.tieId]));
      } else {
        // The member only sees reconciliation ids for deals they participated in.
        expect(answer.firstPaymentDealIds).not.toContain(f.owedDeal);
        if (memberId === f.memberA) expect(answer.calls.find(c => c.meetingId === f.hostChanged)?.paidMinor)
          .toContainEqual({ currency: "usd", paidMinor: 123 });
      }
      const context = await f.t.run(ctx => peopleClosersNext.node!.context(ctx, { tenantId: f.tenantId, filters: { memberId }, range }, []));
      const queries = peopleClosersNext.sql({ tenantId: f.tenantId, filters: { memberId }, range }, context);
      expect(queries.totals.params?.now_ms).toBe(now);
      expect(Object.keys(queries)).toEqual(memberId ? ["totals", "cash", "cohort", "firstPaymentDeals", "callDays", "cashDays", "calls"] : ["totals", "cash", "cohort", "firstPaymentDeals"]);
      if (memberId) expect(queries.calls.sql.indexOf("WHERE closer_id IN")).toBeLessThan(queries.calls.sql.indexOf("LIMIT 301"));
    }
  });
  it("matches the uncapped live accumulator at the 300th call tie, then returns 300 and a cap flag", async () => {
    // The public reader deliberately stops at 300 source meetings. Exercise its
    // accumulator with all facts here so its partial-source cap cannot hide the
    // independent newest-300 list behavior of an aggregate warehouse answer.
    const f = await callsReportFixture();
    const { users, base } = await f.t.run(async ctx => ({ users: await ctx.db.query("users").take(100), base: (await ctx.db.get("meetings", f.hostChanged))! }));
    const facts: CallFact[] = Array.from({ length: 302 }, (_, i) => {
      const meeting: Doc<"meetings"> = { ...base, _id: `meeting${String(i).padStart(4, "0")}` as Id<"meetings">,
        scheduledAt: from + DAY, _creationTime: from + i, heldMarkedAt: from + DAY + (i % 2 ? 29 : 35) * 60000 };
      const proof = { closerId: f.ana, moved: false, rebooked: false };
      return { ...proof, ...callState(meeting, proof, now), meeting, closerName: "Ana", leadName: "Person", programName: "Coaching", standard: false, dealOutcome: "won" };
    });
    const live = buildPeopleClosers({ facts, partial: false, users, payments: [], callPayments: [], cohort: [], firstPaymentIds: [], firstPaymentDealIds: [],
      cohortPartial: false, paymentsPartial: false }, f.memberA, range);
    const rows = { totals: [{ closer_id: f.ana, due: 302, held: 302, first_held: 302, record_minutes: facts.map(f => f.recordMinutes) }],
      calls: facts.slice(0, 301).reverse().map(f => ({ meeting_id: f.meeting._id, opportunity_id: f.meeting.opportunityId,
        scheduled_at_ms: f.meeting.scheduledAt, lead_name: f.leadName, program_name: f.programName, call_status: f.status,
        call_type: f.callType, deal_outcome: f.dealOutcome, paid_minor: [] })), firstPaymentDeals: [],
      callDays: [{ day_key: "2026-09-02", held: 302, no_show: 0, not_recorded: 0 }] };
    const payload = await f.t.query(internal.analytics.results.previewFinalize, { reportId: "people.closers.next", tenantId: f.tenantId,
      filtersJson: JSON.stringify({ memberId: f.memberA }), range, rowsJson: JSON.stringify(rows) });
    expect(JSON.parse(payload)).toEqual(JSON.parse(JSON.stringify(live)));
    expect(live.calls).toHaveLength(300);
    expect(live.calls.at(-1)?.meetingId).toBe("meeting0299");
    expect(live.callsPartial).toBe(true);
  });
});
