import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
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
import { projectWarehouseRows, expectProjectionValues } from "../../../tests/analyticsParity";

import { CALL_COLUMNS } from "./calls";
import { peopleClosers, CLOSER_QUERY_NAMES } from "./people";

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
  it("exports its query names and Node build", () => {
    expect(peopleClosers.node).toBeDefined();
    expect(Object.keys(peopleClosers.sql({ tenantId: "tenant" as Id<"tenants">, filters: {}, range }))).toEqual(CLOSER_QUERY_NAMES);
  });
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
          meetings: projectWarehouseRows({ meetings: f.warehouseRows }, { meetings: CALL_COLUMNS }).meetings,
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
    expectProjectionValues(f.rows, { meetings: CALL_COLUMNS });
    for (const memberId of [null, f.memberA, f.memberB]) {
      const live = await f.t.withIdentity(identity).query(api.reports.people.getPeopleClosers, {
        startDate: from, endDate: to, ...(memberId ? { memberId } : {}),
      });
      const raw = await f.t.query(internal.analytics.results.previewFinalize, {
        tenantId: f.tenantId, reportId: "people.closers", range,
        filtersJson: JSON.stringify({ memberId }),
        rowsJson: JSON.stringify(projectWarehouseRows(f.rows, { meetings: CALL_COLUMNS, payments: null, callPayments: null, firstPayments: null, cohort: null })),
      });
      // The unchanged raw SQL deliberately omits the new lifetime participation
      // metadata. All original figures and the per-closer win sets still match.
      const { firstPaymentDealIds, ...legacy } = live; void firstPaymentDealIds;
      expect(JSON.parse(raw)).toEqual(JSON.parse(JSON.stringify(legacy)));
    }
  });
});
