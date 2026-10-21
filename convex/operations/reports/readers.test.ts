import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";
import { internal } from "../../_generated/api";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import type { ReportSourceRow } from "./model";
import {
  BOOKED_CALLS_WINDOW,
  seedBookedCallsFixture,
} from "../../../tests/bookedCallsFixture";

type SourcePage = FunctionReturnType<
  typeof internal.operations.reports.readers.readReportSourcePage
>;

describe("booked meetings report source", () => {
  it("reads each first booking's team and DM closer from its rows", async () => {
    const t = convexTest({ schema, modules: convexTestModules });
    const fixture = await t.run(async (ctx) => await seedBookedCallsFixture(ctx));

    const rows: SourcePage["page"] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const result: SourcePage = await t.query(internal.operations.reports.readers.readReportSourcePage, {
        tenantId: fixture.tenantId,
        reportKind: "booked-calls",
        sourceKey: "booked_meetings",
        startTimestamp: BOOKED_CALLS_WINDOW.start,
        endTimestampExclusive: BOOKED_CALLS_WINDOW.end,
        startDayKey: "2026-08-14",
        endDayKeyExclusive: "2026-08-15",
        sourceFilter: "all",
        cursor,
      });
      rows.push(...result.page);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }

    const booked = rows.filter(
      (row): row is Extract<ReportSourceRow, { kind: "booked_meeting" }> =>
        row.kind === "booked_meeting",
    );
    expect(booked).toHaveLength(rows.length);
    const byMeeting = Object.fromEntries(
      booked.map((row) => [
        row.meetingId,
        [row.attributionTeamId, row.attributionTeamLabel, row.dmCloserId, row.dmCloserLabel],
      ]),
    );
    // The rebook is a follow-up, two bookings credit no one, and one is
    // outside the window. The team-only booking is read for its team's goal.
    expect(byMeeting).toEqual({
      [fixture.meetings.firstNorthA]: [fixture.teams.north, "North Team", fixture.dmClosers.northA, "Avery North"],
      [fixture.meetings.firstNorthA2]: [fixture.teams.north, "North Team", fixture.dmClosers.northA2, "Avery North Second"],
      [fixture.meetings.legacyNorthB]: [fixture.teams.north, "North Team", fixture.dmClosers.northB, "Blake North"],
      [fixture.meetings.teamOnlySouth]: [fixture.teams.south, "South Team", null, null],
    });
  });
});
