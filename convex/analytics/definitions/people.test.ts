import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { api } from "../../_generated/api";
import {
  callsReportFixture,
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
