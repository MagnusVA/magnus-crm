import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  callsReportFixture,
  identity,
  now,
  windows,
  split,
  range,
} from "../../../tests/callsReportFixtures";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { mergePeopleClosers } from "./people";
import { closerAggregateRows } from "../../../tests/peopleClosersAggregateFixtures";
import { mergeReportPanel } from "../../mcp/reports/merge";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
describe("People closers split merge", () => {
  it("merges cohort, first payments, currencies and lifetime call cash", async () => {
    const f = await callsReportFixture();
    for (const memberId of [null, f.memberA, f.memberB]) {
      const member = memberId ? { memberId } : {};
      await expectMergedAnswer({
        t: f.t,
        identity,
        live: api.reports.people.getPeopleClosers,
        history: { ...windows.history, ...member },
        today: { ...windows.today, ...member },
        whole: { ...windows.whole, ...member },
        merge: mergePeopleClosers,
      });
    }
  });
});

// These windows deliberately read different database states.
describe("first-payment win reconciliation", () => {
  for (const recipient of ["beto", "unattributed"] as const) {
    it(`replaces Ana's historical win when today's first payment becomes ${recipient}`, async () => {
      const f = await callsReportFixture();
      await f.t.run(async ctx => {
        await ctx.db.patch("paymentRecords", f.firstPayment, { attributedCloserId: f.ana });
      });
      const reader = f.t.withIdentity(identity);
      const members = [null, f.memberA, f.memberB];
      const warehouse = async (memberId: typeof f.memberA | null, window: typeof windows.history) => {
        const rows = await closerAggregateRows(f.t, f.tenantId, memberId, { fromMs: window.startDate, toMs: window.endDate });
        const payload = await f.t.query(internal.analytics.results.previewFinalize, {
          tenantId: f.tenantId, reportId: "people.closers.next", filtersJson: JSON.stringify({ memberId }),
          range: { ...range, fromMs: window.startDate, toMs: window.endDate }, rowsJson: JSON.stringify(rows),
        });
        return JSON.parse(payload);
      };
      const warehouseHistory = await Promise.all(members.map(memberId => warehouse(memberId, windows.history)));
      const history = await Promise.all(members.map(memberId => reader.query(api.reports.people.getPeopleClosers, {
        ...windows.history, ...(memberId ? { memberId } : {}),
      })));
      await f.t.run(async ctx => {
        const first = (await ctx.db.get("paymentRecords", f.firstPayment))!;
        await ctx.db.patch("paymentRecords", f.firstPayment, { status: "disputed" });
        const { _id, _creationTime, ...payment } = first;
        void _id; void _creationTime;
        await ctx.db.insert("paymentRecords", { ...payment, status: "recorded", recordedAt: split + 1,
          attributedCloserId: recipient === "beto" ? f.beto : undefined });
      });
      for (const [index, memberId] of members.entries()) {
        const today = await reader.query(api.reports.people.getPeopleClosers, {
          ...windows.today, ...(memberId ? { memberId } : {}),
        });
        expect(today).toMatchObject({ firstPaymentDealIds: expect.arrayContaining([f.won]) });
        const merged = mergePeopleClosers(history[index], today);
        expect(merged.rows.find(r => r.userId === f.ana)?.dealsWon ?? 0).toBe(0);
        expect(merged.rows.find(r => r.userId === f.beto)?.dealsWon ?? 0)
          .toBe(recipient === "beto" && memberId !== f.memberA ? 1 : 0);
        expect(mergeReportPanel("people.closers", history[index], today)).toEqual(merged);
        const warehouseToday = await warehouse(memberId, windows.today);
        expect(warehouseToday).toEqual(JSON.parse(JSON.stringify(today)));
        expect(mergePeopleClosers(warehouseHistory[index], warehouseToday)).toEqual(merged);
      }
    });
  }
});

it("keeps scalar win addition for cached answers missing reconciliation fields on either side", async () => {
  const f = await callsReportFixture();
  const reader = f.t.withIdentity(identity);
  const history = await reader.query(api.reports.people.getPeopleClosers, windows.history);
  const today = await reader.query(api.reports.people.getPeopleClosers, windows.today);
  const legacy = (answer: typeof today) => {
    const { firstPaymentDealIds, ...rest } = answer; void firstPaymentDealIds;
    return { ...rest, rows: answer.rows.map(r => { const { wonDealIds, ...rest } = r; void wonDealIds; return rest; }) };
  };
  // Deliberately overlap a scalar win across windows. Legacy behavior sums it.
  today.rows = today.rows.map(r => ({ ...r, dealsWon: 2 }));
  for (const [a, b] of [[legacy(history), legacy(today)], [legacy(history), today], [history, legacy(today)]]) {
    const merged = mergePeopleClosers(a, b);
    for (const r of merged.rows) expect(r.dealsWon).toBe(
      (a.rows.find(x => x.userId === r.userId)?.dealsWon ?? 0) + (b.rows.find(x => x.userId === r.userId)?.dealsWon ?? 0));
    expect(merged.firstPaymentDealIds).toBeUndefined();
  }
});
