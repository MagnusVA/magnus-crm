import { afterEach, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { ATTENDANCE_NOW, showRateFixture } from "../../tests/showRateFixtures";
import { getPhoneCloserOperationsOverviewSection } from "../dashboard/overviewOperations";
import { deriveOverviewRange } from "../dashboard/overviewRange";
import { readSourcePage } from "./reports/readers";
import type { ReportSourceRow } from "./reports/model";
import { isHeldStatus } from "../lib/meetingAttendance";

afterEach(() => vi.useRealTimers());
const range = {
  kind: "custom" as const,
  startBusinessDate: "2026-10-21",
  endBusinessDateInclusive: "2026-10-22",
};
const dayRange = {
  startDayKey: "2026-10-21",
  endDayKeyExclusive: "2026-10-23",
};
const timestampRange = {
  startDate: Date.parse("2026-10-21T00:00:00Z"),
  endDate: Date.parse("2026-10-23T00:00:00Z"),
};
const results = { resultsRecorded: 3, pastCalls: 5 };

it("uses recorded attendance in every live report and excludes in-progress/upcoming calls from past calls", async () => {
  const { admin, t, tenantId, teamId } = await showRateFixture();
  const sales = await admin.query(
    api.operations.salesCallsDashboard.getSalesCallsDashboard,
    { range },
  );
  for (const row of [
    sales.stats,
    sales.closers[0],
    sales.teamTotal,
    sales.perProgram[0],
  ]) {
    expect(row).toMatchObject({ ...results, showUpRate: 2 / 3 });
  }
  expect(sales.stats).toMatchObject({
    totalCalls: 8,
    showed: 2,
    noShows: 1,
    canceled: 1,
  });
  for (const filters of [{}, { attributionTeamId: teamId }]) {
    const pipeline = await admin.query(
      api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions,
      { ...dayRange, ...filters },
    );
    expect(pipeline).toMatchObject({
      ...results,
      scheduled: 8,
      showRate: 2 / 3,
      noShowRate: 1 / 3,
    });
    const team = await admin.query(
      api.reporting.teamPerformance.getTeamOperationsDimensions,
      { ...timestampRange, ...filters },
    );
    for (const row of [team.rows[0], team.totals]) {
      expect(row).toMatchObject({
        ...results,
        notRecorded: 2,
        showRate: 2 / 3,
        noShowRate: 1 / 3,
      });
    }
  }
  const performance = await admin.query(
    api.reporting.teamPerformance.getTeamPerformanceMetrics,
    timestampRange,
  );
  expect(performance.closers[0].newCalls).toMatchObject({
    ...results,
    showUpRate: 2 / 3,
  });
  expect(performance.teamTotals).toMatchObject({
    newPastCalls: 5,
    overallShowUpRate: 2 / 3,
  });
  const outcomes = await admin.query(
    api.reporting.teamOutcomes.getTeamOutcomeMix,
    timestampRange,
  );
  expect(outcomes.displayOutcome).toMatchObject({
    not_recorded: 2,
    upcoming: 2,
    scheduled: 2,
  });
  expect(outcomes.teamOutcome.scheduled).toBe(6);
  const overview = await t.run((ctx) =>
    getPhoneCloserOperationsOverviewSection(
      ctx,
      tenantId,
      deriveOverviewRange(range, ATTENDANCE_NOW),
    ),
  );
  for (const row of [overview.data.rows[0], overview.data.totals]) {
    expect(row).toMatchObject({
      ...results,
      scheduled: 8,
      showRate: 2 / 3,
      noShowRate: 1 / 3,
    });
  }
});

it("returns null rates when scheduled calls have no attendance result", async () => {
  const { admin } = await showRateFixture();
  const empty = await admin.query(
    api.operations.salesCallsDashboard.getSalesCallsDashboard,
    {
      range: {
        kind: "custom",
        startBusinessDate: "2026-10-23",
        endBusinessDateInclusive: "2026-10-23",
      },
    },
  );
  expect(empty.stats).toMatchObject({
    showUpRate: null,
    resultsRecorded: 0,
    pastCalls: 0,
    totalCalls: 2,
  });
  expect(isHeldStatus("completed")).toBe(true);
  expect(isHeldStatus("scheduled")).toBe(false);
  expect(isHeldStatus("no_show")).toBe(false);
});

it("splits both UTC buckets intersecting today's business day without reading tomorrow's calls", async () => {
  const { admin, teamId } = await showRateFixture(
    Date.parse("2026-10-23T02:00:00Z"),
  );
  for (const filters of [{}, { attributionTeamId: teamId }]) {
    const team = await admin.query(
      api.reporting.teamPerformance.getTeamOperationsDimensions,
      {
        startDate: Date.parse("2026-10-22T00:00:00Z"),
        endDate: Date.parse("2026-10-24T00:00:00Z"),
        ...filters,
      },
    );
    expect(team.totals).toMatchObject({
      scheduled: 8,
      notRecorded: 4,
      resultsRecorded: 2,
      pastCalls: 6,
      showRate: 0.5,
      noShowRate: 0.5,
    });
  }
});

it("exports the stored status and Not recorded attendance separately", async () => {
  const { t, tenantId } = await showRateFixture();
  for (const [reportKind, sourceKey] of [
    ["sales-calls", "sales_calls"],
    ["booked-calls", "booked_meetings"],
  ] as const) {
    let cursor: string | null = null;
    const rows: ReportSourceRow[] = [];
    for (let page = 0; page < 6; page++) {
      const result = await t.run((ctx) =>
        readSourcePage(ctx, {
          tenantId,
          reportKind,
          sourceKey,
          sourceFilter: "all",
          teamId: null,
          workerId: null,
          cursor,
          startTimestamp:
            sourceKey === "booked_meetings" ? 0 : timestampRange.startDate,
          endTimestampExclusive: timestampRange.endDate,
          ...dayRange,
        }),
      );
      rows.push(...result.page);
      if (result.isDone) break;
      expect(result.continueCursor).not.toBe(cursor);
      cursor = result.continueCursor;
    }
    expect(rows).toContainEqual(
      expect.objectContaining({
        ...(sourceKey === "sales_calls"
          ? { status: "scheduled" }
          : { meetingStatus: "scheduled" }),
        attendance: "Not recorded",
      }),
    );
  }
});
