import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { scorecardFixture, whole, history, today, identity, HOUR } from "../../tests/scorecardFixtures";
import { buildAnswers, buildCash, buildFollowThrough, buildFunnel, buildLifecycle, buildOrigins } from "./scorecard";
import { privateAnswer } from "./lib/scorecardFacts";
import { syncLeadStageEntries } from "../lib/leadLifecycle";

afterEach(() => vi.useRealTimers());
describe("Scorecard builders", () => {
  it("keeps deposits in cash, final cash separate and currencies apart", async () => {
    const f = await scorecardFixture();
    const result = buildCash(f, whole, {});
    expect(result.currencies.map(c => [c.currency, c.cashMinor, c.finalMinor, c.depositMinor, c.dealsWon])).toEqual([
      ["EUR", 25000, 25000, 0, 1], ["USD", 102000, 90000, 12000, 2],
    ]);
    const usd = result.currencies[1];
    expect(usd.depositsOnLostDeals).toBe(2000);
    expect(usd.finalOnWonDealsMinor).toBe(90000);
    expect(usd.byType).toEqual({ pif: 0, split: 90000, monthly: 0, deposit: 12000 });
    expect(usd.byProgram[0]).toMatchObject({ payments: 3, dealsWon: 2, finalOnWonDealsMinor: 90000 });
  });
  it("counts each deal once by first payment and excludes replacement bookings", async () => {
    const f = await scorecardFixture();
    const result = buildFunnel(f, whole, {}, buildLifecycle(f.people, whole));
    expect(result.activity).toMatchObject({ dealsWon: 3, bookingsMade: 3, callsHeld: 2 });
    expect(result.byDay.map(d => [d.bookingsMade, d.callsHeld, d.dealsWon])).toEqual([[2, 0, 2], [1, 2, 1]]);
    const doubled = { ...f, deals: [...f.deals, ...f.deals] };
    expect(buildFunnel(doubled, whole, {}).activity.dealsWon).toBe(3);
    expect(buildFunnel(f, today, {}).activity.dealsWon).toBe(1);
  });
  it("separates stage entries in range from a cohort's later progress and skips merged people", async () => {
    const f = await scorecardFixture();
    const result = buildLifecycle(f.people, history);
    expect(result.stages).toEqual({ prospect: 1, in_conversation: 1, qualified: 1, booked: 1, showed: 0, customer: 0 });
    expect(result.cohort).toEqual({ entered: 1, qualified: 1, booked: 1, showed: 1, customer: 1 });
    expect(buildLifecycle(f.people, whole).cohort.entered).toBe(2);
  });
  it("uses the end of the due business day for completion and the due instant for open overdue", async () => {
    const f = await scorecardFixture();
    expect(buildFollowThrough(f.reminders, f.users, whole, whole.toMs)).toMatchObject({ due: 3, onTime: 1, late: 1, openOverdue: 1 });
    expect(buildFollowThrough(f.reminders, f.users, whole, today.fromMs)).toMatchObject({ openOverdue: 0 });
    // Across the New York DST fallback, the business day is 25 hours.
    const range = { startDate: "2026-11-01", endDateInclusive: "2026-11-01", fromMs: Date.UTC(2026, 10, 1, 4), toMs: Date.UTC(2026, 10, 2, 5), timeZone: "America/New_York", dayStartHour: 0 };
    const r = { ...f.reminders[0], reminderScheduledAt: range.fromMs + HOUR, completedAt: range.toMs - 1 };
    expect(buildFollowThrough([r], f.users, range, range.toMs).onTime).toBe(1);
  });
  it("groups frozen first touch, including late installments on an older winning deal", async () => {
    const f = await scorecardFixture();
    expect(buildOrigins(f, whole, {})).toEqual({ origins: [
      { channel: "lead_gen", dealsWon: 1, cash: [{ currency: "USD", cashMinor: 100000, finalMinor: 90000 }] },
      { channel: "unknown", dealsWon: 2, cash: [{ currency: "EUR", cashMinor: 25000, finalMinor: 25000 }, { currency: "USD", cashMinor: 2000, finalMinor: 0 }] },
    ] });
    expect(buildOrigins(f, today, {}).origins[0]).toEqual({ channel: "lead_gen", dealsWon: 0, cash: [{ currency: "USD", cashMinor: 90000, finalMinor: 90000 }] });
  });
  it("counts a side deal under the program it was sold as, and a booked deal under the program it was booked for", async () => {
    const f = await scorecardFixture();
    const other = "other_program" as Id<"tenantPrograms">;
    const withDealB = (fields: Partial<Doc<"opportunities">>) => ({ ...f, deals: f.deals.map(d => d._id === f.dealB ? { ...d, ...fields } : d) });
    // Never booked: no booked program, so the first payment's program decides.
    const side = withDealB({ firstBookingProgramId: undefined });
    expect(buildFunnel(side, whole, { programId: f.programId }).activity.dealsWon).toBe(3);
    expect(buildFunnel(side, whole, { programId: other }).activity.dealsWon).toBe(0);
    expect(buildOrigins(side, whole, { programId: f.programId }).origins.reduce((sum, o) => sum + o.dealsWon, 0)).toBe(3);
    // Booked for another program and sold as this one: the booked program decides.
    const sold = withDealB({ firstBookingProgramId: other });
    expect(buildFunnel(sold, whole, { programId: f.programId }).activity.dealsWon).toBe(2);
    expect(buildFunnel(sold, whole, { programId: other }).activity.dealsWon).toBe(1);
  });
  it("normalizes answers and counts people once: for the answer, a held call and a sale", async () => {
    const f = await scorecardFixture();
    const facts = { responses: f.responses, deals: f.deals, heldDealIds: [f.dealA, f.dealB], contactLabels: [] };
    expect(buildAnswers(facts, "budget").answers).toEqual([
      { answer: "High", people: 1, held: 1, won: 1 }, { answer: "Low", people: 1, held: 1, won: 1 },
    ]);
    // A second won deal with a held call for the same person is still one person.
    const second = { ...f.deals.find(d => d._id === f.dealA)!, _id: "second_deal" as Id<"opportunities"> };
    expect(buildAnswers({ ...facts, deals: [...f.deals, second], heldDealIds: [f.dealA, f.dealB, second._id] }, "budget").answers[0])
      .toEqual({ answer: "High", people: 1, held: 1, won: 1 });
    for (const answer of ["a@example.com", " +1 (555) 123-4567", "@handle", "https://instagram.com/name"]) {
      expect(privateAnswer(answer, "Budget", [])).toBe("Hidden contact detail");
    }
    expect(privateAnswer("secret handle", "Phone", ["Phone"])).toBe("Hidden contact detail");
    expect(buildAnswers({ ...facts, responses: [{ ...f.responses[0], questionLabelSnapshot: "Phone", answerText: "secret handle" }], contactLabels: ["Phone"] }, "budget").answers[0].answer).toBe("Hidden contact detail");
  });
});
describe("Scorecard readers", () => {
  it("reads actual entry-time aggregate keys, including skipped stages", async () => {
    const f = await scorecardFixture();
    const output = await f.t.withIdentity(identity).query(api.reports.scorecard.funnel, { range: whole });
    expect(output.stages).toEqual(buildLifecycle(f.people, whole).stages);
  });
  it("rejects anonymous and closer access to every reader", async () => {
    const f = await scorecardFixture();
    const refs = [api.reports.scorecard.funnel, api.reports.scorecard.cash, api.reports.scorecard.followThrough, api.reports.scorecard.origins];
    for (const ref of refs) {
      await expect(f.t.query(ref, { range: whole })).rejects.toThrow("Not authenticated");
      await expect(f.t.withIdentity({ subject: "score_closer", org_id: identity.org_id }).query(ref, { range: whole })).rejects.toThrow("Insufficient permissions");
    }
    await expect(f.t.query(api.reports.scorecard.answers, { range: whole, fieldKey: "budget" })).rejects.toThrow("Not authenticated");
  });
  it("fails clearly when a bounded read would give a partial answer", async () => {
    const f = await scorecardFixture();
    await f.t.run(async ctx => {
      const base = f.payments[0];
      const { _id, _creationTime, ...fields } = base;
      void _id; void _creationTime;
      for (let i = 0; i < 2501; i++) await ctx.db.insert("paymentRecords", { ...fields, recordedAt: whole.fromMs + i });
    });
    await expect(f.t.withIdentity(identity).query(api.reports.scorecard.cash, { range: whole })).rejects.toThrow("Choose a shorter range");
  });
  it("counts a busy day's funnel: 700 people of realistic size entering it", async () => {
    // Production, Nov 9: about 650 people entered In conversation in one day,
    // and the live funnel failed with "Choose a shorter range".
    const f = await scorecardFixture();
    const at = today.fromMs + HOUR;
    for (let batch = 0; batch < 700; batch += 50) await f.t.run(async ctx => {
      for (let i = batch; i < batch + 50; i++) {
        const times = { prospect: at + i, in_conversation: at + i };
        const id = await ctx.db.insert("leads", { tenantId: f.tenantId, fullName: `Busy ${i}`, firstSeenAt: at, updatedAt: at,
          status: "active", lifecycleStage: "in_conversation", lifecycleStageEnteredAt: times, disposition: "open",
          searchText: `busy ${i} ${"x".repeat(700)}` });
        await syncLeadStageEntries(ctx, f.tenantId, id, null, { stage: "in_conversation", enteredAt: times });
      }
    });
    const output = await f.t.withIdentity(identity).query(api.reports.scorecard.funnel, { range: today });
    expect(output.stages.in_conversation).toBeGreaterThanOrEqual(700);
  });
  async function seedSixStages(f: Awaited<ReturnType<typeof scorecardFixture>>, count: number) {
    const at = today.fromMs + HOUR;
    const payment = f.payments[0];
    const { _id, _creationTime, ...paymentFields } = payment;
    void _id; void _creationTime;
    for (let batch = 0; batch < count; batch += 25) await f.t.run(async ctx => {
      for (let i = batch; i < Math.min(count, batch + 25); i++) {
        const times = { prospect: at + i, in_conversation: at + i, qualified: at + i, booked: at + i, showed: at + i, customer: at + i };
        const id = await ctx.db.insert("leads", { tenantId: f.tenantId, fullName: `Six ${i}`, firstSeenAt: at, updatedAt: at,
          status: "active", lifecycleStage: "customer", lifecycleStageEnteredAt: times, disposition: "open",
          searchText: `six ${i} ${"x".repeat(1500)}` });
        await syncLeadStageEntries(ctx, f.tenantId, id, null, { stage: "customer", enteredAt: times });
        // Every tenth person paid today, so the funnel also joins payment deals.
        if (i % 10 === 0) {
          const dealId = await ctx.db.insert("opportunities", { ...(await ctx.db.get("opportunities", f.dealA))!, _id: undefined, _creationTime: undefined, leadId: id } as never);
          await ctx.db.insert("paymentRecords", { ...paymentFields, opportunityId: dealId, recordedAt: at + i });
        }
      }
    });
  }
  it("stays inside Convex's per-query limits when 1,400 people enter all six stages and pay", async () => {
    const f = await scorecardFixture();
    await seedSixStages(f, 1400);
    const output = await f.t.withIdentity(identity).query(api.reports.scorecard.funnel, { range: today });
    expect(output.stages.customer).toBeGreaterThanOrEqual(1400);
  }, 240_000);
  it("refuses as a shorter range, not a Convex limit, when the stage walk would not fit", async () => {
    const f = await scorecardFixture();
    await seedSixStages(f, 1600);
    await expect(f.t.withIdentity(identity).query(api.reports.scorecard.funnel, { range: today })).rejects.toThrow("Choose a shorter range");
  }, 240_000);
  it("filters bookings by booking program and cash by payment program", async () => {
    const f = await scorecardFixture();
    const otherId = await f.t.run(ctx => ctx.db.insert("tenantPrograms", { tenantId: f.tenantId, name: "Other", normalizedName: "other", createdByUserId: f.adminId, createdAt: 0, updatedAt: 0 }));
    await f.t.run(ctx => ctx.db.patch("paymentRecords", f.depositId, { programId: otherId, programName: "Other" }));
    const output = await f.t.withIdentity(identity).query(api.reports.scorecard.cash, { range: history, programId: otherId });
    expect(output.currencies[0].cashMinor).toBe(10000);
    const activity = await f.t.withIdentity(identity).query(api.reports.scorecard.funnel, { range: history, programId: otherId });
    expect(activity.activity.bookingsMade).toBe(0);
  });
});
