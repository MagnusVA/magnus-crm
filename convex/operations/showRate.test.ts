import { afterEach, expect, it, vi } from "vitest";
import * as attendanceHelpers from "../lib/meetingAttendance";
import { api, internal } from "../_generated/api";
import { ATTENDANCE_NOW, attendanceStorageModes, heldAttendanceFixture, showRateFixture } from "../../tests/showRateFixtures";
import { getPhoneCloserOperationsOverviewSection } from "../dashboard/overviewOperations";
import { deriveOverviewRange } from "../dashboard/overviewRange";
import { readSourcePage } from "./reports/readers";
import type { ReportSourceRow } from "./reports/model";
import {
  attendanceDayBounds,
  isHeldStatus,
  readScheduledAttendanceDay,
  withAttendanceCounts,
} from "../lib/meetingAttendance";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";
import { insertMeetingAggregate } from "../reporting/writeHooks";
import { recordBookingAttribution } from "../lib/attribution/dealAttributions";
import { readMeetingStatsCounts } from "./meetingStats";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
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
  startDate: Date.parse("2026-10-21T07:00:00Z"),
  endDate: Date.parse("2026-10-23T07:00:00Z"),
};
const results = { resultsRecorded: 3, pastCalls: 5 };

it.each(attendanceStorageModes)("uses %s attendance in every live report without counting held calls twice", async (storage) => {
  const { admin, t, tenantId, teamId } = await heldAttendanceFixture(storage);
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
  expect(sales.attendanceCountsPartial).toBe(false);
  expect(sales.stats).toMatchObject({
    totalCalls: 9,
    showed: 2,
    noShows: 1,
    canceled: 1,
  });
  for (const filters of [{}, { attributionTeamId: teamId }]) {
    const pipeline = await admin.query(
      api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions,
      { ...dayRange, ...filters },
    );
    expect(pipeline.attendanceCountsPartial).toBe(false);
    expect(pipeline).toMatchObject({
      ...results,
      scheduled: 9,
      showRate: 2 / 3,
      noShowRate: 1 / 3,
    });
    const team = await admin.query(
      api.reporting.teamPerformance.getTeamOperationsDimensions,
      { ...timestampRange, ...filters },
    );
    expect(team.attendanceCountsPartial).toBe(false);
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
  expect(performance.attendanceCountsPartial).toBe(false);
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
    upcoming: 3,
    scheduled: 2,
  });
  expect(outcomes.teamOutcome.scheduled).toBe(7);
  const overview = await t.run((ctx) =>
    getPhoneCloserOperationsOverviewSection(
      ctx,
      tenantId,
      deriveOverviewRange(range, ATTENDANCE_NOW),
    ),
  );
  expect(overview.data.attendanceCountsPartial).toBe(false);
  for (const row of [overview.data.rows[0], overview.data.totals]) {
    expect(row).not.toHaveProperty("completed");
    expect(row).toMatchObject({
      held: 2,
      ...results,
      scheduled: 9,
      showRate: 2 / 3,
      noShowRate: 1 / 3,
    });
  }
});

it.each(attendanceStorageModes)("counts %s held attendance once in each aggregate call classification", async (storage) => {
  const { t, admin } = await heldAttendanceFixture(storage);
  await t.run(async (ctx) => {
    const held = (await ctx.db.query("meetings").take(20))
      .filter((meeting) => isHeldStatus(meeting.status));
    expect(held).toHaveLength(2);
    await patchMeetingLifecycle(ctx, held[0]._id, { callClassification: "follow_up" });
  });
  const performance = await admin.query(
    api.reporting.teamPerformance.getTeamPerformanceMetrics,
    timestampRange,
  );
  const closer = performance.closers[0];
  expect(closer.newCalls).toMatchObject({ bookedCalls: 8, callsShowed: 1, showUpRate: 1 / 2 });
  expect(closer.followUpCalls).toMatchObject({ bookedCalls: 1, callsShowed: 1, showUpRate: 1 });
  expect(performance.teamTotals).toMatchObject({
    newBookedCalls: 8,
    newShowed: 1,
    followUpBookedCalls: 1,
    followUpShowed: 1,
    overallShowUpRate: 2 / 3,
  });
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
    totalCalls: 1,
  });
  expect(isHeldStatus("completed")).toBe(true);
  expect(isHeldStatus("held")).toBe(true);
  expect(isHeldStatus("scheduled")).toBe(false);
  expect(isHeldStatus("no_show")).toBe(false);
});

it("splits the business-day buckets intersecting today's attendance window without reading tomorrow's calls", async () => {
  const { admin, teamId } = await showRateFixture(
    Date.parse("2026-10-23T02:00:00Z"),
  );
  for (const filters of [{}, { attributionTeamId: teamId }]) {
    const team = await admin.query(
      api.reporting.teamPerformance.getTeamOperationsDimensions,
      {
        startDate: Date.parse("2026-10-22T07:00:00Z"),
        endDate: Date.parse("2026-10-24T07:00:00Z"),
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

it("keeps pre-business-day calls in progress and splits business-day buckets in the 24-hour window", async () => {
  const now = Date.parse("2026-10-22T07:05:00Z");
  const { t, admin, tenantId, closerId, teamId } = await showRateFixture(now);
  expect(attendanceDayBounds(now)).toEqual({
    start: Date.parse("2026-10-21T07:05:00Z"),
    end: Date.parse("2026-10-23T07:00:00Z"),
  });
  const added = await t.run(async (ctx) => {
    const template = await ctx.db.query("meetings")
      .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "scheduled"))
      .first();
    if (!template) throw new Error("Missing fixture meeting");
    const specs = [
      ["older-than-24h", "2026-10-21T01:00:00Z", 30, 1],
      ["middle-bucket-finished", "2026-10-22T00:00:00Z", 30, 1],
      ["before-business-day-in-progress", "2026-10-22T06:30:00Z", 60, 0],
      ["ended-two-minutes-ago", "2026-10-22T06:33:00Z", 30, 1],
    ] as const;
    const added = [];
    for (const [key, at, durationMinutes, notRecorded] of specs) {
      const meetingId = await ctx.db.insert("meetings", {
        tenantId,
        opportunityId: template.opportunityId,
        assignedCloserId: closerId,
        calendlyEventUri: `https://api.calendly.com/scheduled_events/${key}`,
        calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${key}/invitees/test`,
        scheduledAt: Date.parse(at),
        durationMinutes,
        status: "scheduled",
        callClassification: "new",
        createdAt: 0,
      });
      const meeting = await insertMeetingAggregate(ctx, meetingId);
      await recordBookingAttribution(ctx, { meeting, credit: { teamId } });
      added.push({ meetingId, notRecorded });
    }
    return added;
  });
  // The fixture drains Workpool and rewinds its clock. Apply these projections
  // directly so the report test reads buckets containing every added meeting.
  for (const { meetingId } of added) {
    const projection = await t.run((ctx) => ctx.db.query("meetingProjections")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId)).unique());
    if (!projection) throw new Error("Missing fixture projection");
    await t.mutation(internal.operations.meetingStats.project, {
      projectionId: projection._id,
      generation: projection.generation,
    });
    expect(await t.run((ctx) => ctx.db.get("meetingProjections", projection._id)))
      .toMatchObject({ status: "applied" });
  }
  for (const filters of [{}, { attributionTeamId: teamId }]) {
    const result = await t.run(async (ctx) => {
      const { counts } = await readMeetingStatsCounts(ctx, { tenantId, ...dayRange, startDayKey: "2026-10-20", ...filters });
      // Attendance reads raw meetings, so all four additions must also be in
      // the applied buckets before comparing the two sources.
      expect(counts.reduce((sum, row) => sum + row.count, 0)).toBe(13);
      expect(counts.filter((row) => row.dayKey === "2026-10-22" && row.meetingStatus === "scheduled")
        .reduce((sum, row) => sum + row.count, 0)).toBe(4);
      return await withAttendanceCounts(ctx, tenantId, counts, now);
    });
    expect(result.attendanceCountsPartial).toBe(false);
    // Three additions have ended, plus the fixture's yesterday-unrecorded call.
    expect(result.counts.reduce((sum, row) => sum + row.notRecorded, 0)).toBe(4);
    expect(result.counts.filter((row) => row.dayKey === "2026-10-22")
      .reduce((sum, row) => sum + row.notRecorded, 0)).toBe(0);
    if ("attributionTeamId" in filters) {
      for (const expected of added) {
        expect(result.counts).toContainEqual(expect.objectContaining(expected));
      }
    }
    const team = await admin.query(api.reporting.teamPerformance.getTeamOperationsDimensions, {
      ...timestampRange, startDate: Date.parse("2026-10-20T07:00:00Z"), ...filters,
    });
    expect(team.totals.notRecorded).toBe(4);
    const pipeline = await admin.query(api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions, {
      ...dayRange, startDayKey: "2026-10-20", ...filters,
    });
    expect(pipeline.pastCalls).toBe(7);
  }
  const performance = await admin.query(api.reporting.teamPerformance.getTeamPerformanceMetrics, { ...timestampRange, startDate: Date.parse("2026-10-20T07:00:00Z") });
  expect(performance.teamTotals.newPastCalls).toBe(7);

  const upcoming = await admin.query(api.reporting.teamPerformance.getTeamOperationsDimensions, {
    startDate: Date.parse("2026-10-23T07:00:00Z"),
    endDate: Date.parse("2026-10-24T07:00:00Z"),
  });
  expect(upcoming.totals).toMatchObject({ scheduled: 1, notRecorded: 0, pastCalls: 0 });
});

it("returns partial attendance at a small cap, keeping unread earlier calls finished and later calls upcoming", async () => {
  const { t, tenantId, teamId } = await showRateFixture();
  const scan = await t.run((ctx) => readScheduledAttendanceDay(ctx, tenantId, ATTENDANCE_NOW, 2));
  expect(scan.attendanceCountsPartial).toBe(true);
  expect(scan.meetings.map((meeting) => meeting.scheduledAt)).toEqual([
    Date.parse("2026-10-22T17:30:00Z"),
    Date.parse("2026-10-22T17:45:00Z"),
  ]);
  for (const filters of [{}, { attributionTeamId: teamId }]) {
    const { partial, complete } = await t.run(async (ctx) => {
      const { counts } = await readMeetingStatsCounts(ctx, { tenantId, ...dayRange, ...filters });
      return {
        partial: await withAttendanceCounts(ctx, tenantId, counts, ATTENDANCE_NOW, 2),
        complete: await withAttendanceCounts(ctx, tenantId, counts, ATTENDANCE_NOW),
      };
    });
    expect(partial.attendanceCountsPartial).toBe(true);
    expect(complete.attendanceCountsPartial).toBe(false);
    expect(partial.counts).toEqual(complete.counts);
    expect(partial.counts.filter((row) => row.dayKey === "2026-10-21")
      .reduce((sum, row) => sum + row.notRecorded, 0)).toBe(1);
    expect(partial.counts.filter((row) => row.dayKey === "2026-10-22")
      .reduce((sum, row) => sum + row.notRecorded, 0)).toBe(1);
  }
});


it("persists a capped attendance scan in every snapshot attendance result", async () => {
  const { t, admin } = await showRateFixture();
  const original = attendanceHelpers.withAttendanceCounts;
  // Keep the fixture small while exercising the real bounded scan and worker.
  vi.spyOn(attendanceHelpers, "withAttendanceCounts").mockImplementation(
    (ctx, tenantId, rows, now) => original(ctx, tenantId, rows, now, 2),
  );
  const { jobId } = await admin.mutation(
    api.operations.reports.jobs.requestDashboardReport,
    { reportKind: "sales-calls", range, requestToken: "partial-attendance" },
  );
  for (let step = 0; step < 20; step += 1) {
    await t.action(internal.operations.reports.worker.run, { jobId });
    const job = await t.run((ctx) => ctx.db.get("operationsReportJobs", jobId));
    if (job?.status === "ready") break;
    expect(job?.status).toBe("queued");
  }
  const summary = await admin.query(
    api.operations.reports.jobs.getDashboardReportSummary, { jobId },
  );
  expect(summary?.payload).toMatchObject({
    attendanceCountsPartial: true, ...results,
  });
  for (const section of ["sales_closer", "sales_program"]) {
    const rows = await admin.query(api.operations.reports.jobs.listDashboardReportRows, {
      jobId, section, paginationOpts: { cursor: null, numItems: 100 },
    });
    expect(rows.page.length).toBeGreaterThan(0);
    for (const row of rows.page) {
      expect(row.payload).toMatchObject({ attendanceCountsPartial: true, ...results });
    }
  }
});
