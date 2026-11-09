import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { api } from "../../_generated/api";
import {
  callsReportFixture,
  identity,
  now,
  windows,
} from "../../../tests/callsReportFixtures";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { mergePeopleClosers } from "./people";

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
