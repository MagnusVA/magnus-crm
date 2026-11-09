import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  callsReportFixture,
  warehouseMonthFixture,
  from,
  identity,
  now,
  range,
  to,
} from "../../../tests/callsReportFixtures";
import { expectSameAnswer } from "../../../tests/analyticsParity";

vi.mock("../registry", async () => {
  const { peopleCloserReports } = await import("./people");
  return {
    getReportDefinition: (id: string) =>
      peopleCloserReports.find((r) => r.id === id)!,
  };
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
describe("People closers warehouse parity", () => {
  it("uses warehouse dimensions for a month and the cohort SQL outcome for wins", async () => {
    const f = await warehouseMonthFixture();
    // Cohort outcome intentionally differs from both current Convex state and
    // the meeting SQL's outcome: the cohort row is the source of this tally.
    const payload = await f.t.query(
      internal.analytics.results.previewFinalize,
      {
        tenantId: f.tenantId,
        reportId: "people.closers",
        range,
        filtersJson: JSON.stringify({ memberId: f.memberA }),
        rowsJson: JSON.stringify({
          meetings: f.warehouseRows,
          payments: [],
          callPayments: [],
          firstPayments: [],
          cohort: f.warehouseRows.map((r) => ({
            meeting_id: r.id,
            outcome: "won",
          })),
        }),
      },
    );
    const answer = JSON.parse(payload);
    expect(answer).toMatchObject({
      partial: false,
      cohortPartial: false,
      rows: [{ cohortDeals: 1001, cohortWon: 1001 }],
    });
    expect(answer.calls).toHaveLength(300);
    expect(answer.calls[0]).toMatchObject({
      leadName: "Warehouse person 1000",
      dealOutcome: "won",
    });
    expect(answer.calls[1]).toMatchObject({
      leadName: "Warehouse person 999",
      dealOutcome: "lost",
    });
  });
  it("matches the roster and each member's days and calls", async () => {
    const f = await callsReportFixture();
    for (const memberId of [null, f.memberA, f.memberB]) {
      await expectSameAnswer({
        t: f.t,
        identity,
        tenantId: f.tenantId,
        reportId: "people.closers",
        live: api.reports.people.getPeopleClosers,
        liveArgs: {
          startDate: from,
          endDate: to,
          ...(memberId ? { memberId } : {}),
        },
        filters: { memberId },
        range,
        rows: f.rows,
      });
    }
  });
});
