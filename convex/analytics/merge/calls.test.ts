import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import {
  callsReportFixture,
  identity,
  now,
  windows,
} from "../../../tests/callsReportFixtures";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { mergeCallsSummary } from "./calls";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
describe("Calls split merge", () => {
  it("adds adjacent windows including moved slots and rebooks", async () => {
    const f = await callsReportFixture();
    const result = await expectMergedAnswer({
      t: f.t,
      identity,
      live: api.reports.calls.getCallsSummary,
      ...windows,
      merge: mergeCallsSummary,
    });
    const twice = mergeCallsSummary(result.whole, result.whole);
    expect(twice.owed).toHaveLength(result.whole.owed.length);
    expect(twice.recordMinutes).toHaveLength(
      2 * result.whole.recordMinutes.length,
    );
  });
});
