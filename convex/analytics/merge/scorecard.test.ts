import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { scorecardFixture, whole, history, today, identity } from "../../../tests/scorecardFixtures";
import { mergeAnswers, mergeCash, mergeFollowThrough, mergeFunnel, mergeOrigins } from "./scorecard";

afterEach(() => vi.useRealTimers());
describe("Scorecard split ranges", () => {
  it("adds each mergeable report's adjacent answers to its whole-range answer", async () => {
    vi.useFakeTimers(); vi.setSystemTime(whole.toMs + 1000);
    const f = await scorecardFixture();
    const args = { t: f.t, identity, history: { range: history }, today: { range: today }, whole: { range: whole } };
    await expectMergedAnswer({ ...args, live: api.reports.scorecard.funnel, merge: mergeFunnel });
    await expectMergedAnswer({ ...args, live: api.reports.scorecard.cash, merge: mergeCash });
    await expectMergedAnswer({ ...args, live: api.reports.scorecard.followThrough, merge: mergeFollowThrough });
    const result = await expectMergedAnswer({ ...args, live: api.reports.scorecard.origins, merge: mergeOrigins });
    expect(result.whole.origins.find(o => o.channel === "lead_gen")).toMatchObject({ dealsWon: 1, cash: [{ cashMinor: 100000, finalMinor: 90000 }] });
  });
  it("reads answers whole because a person's bookings cross the split", async () => {
    const f = await scorecardFixture(); const reader = f.t.withIdentity(identity);
    const read = (range: typeof whole) => reader.query(api.reports.scorecard.answers, { range, fieldKey: "budget" });
    const [a, b, all] = await Promise.all([read(history), read(today), read(whole)]);
    expect(a.answers.find(r => r.answer === "High")?.people).toBe(1);
    expect(b.answers.find(r => r.answer === "High")?.people).toBe(1);
    expect(all.answers.find(r => r.answer === "High")?.people).toBe(1);
    expect(mergeAnswers).toBeNull();
  });
});
