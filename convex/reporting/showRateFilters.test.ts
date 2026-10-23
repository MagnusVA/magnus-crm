/**
 * The show-rate reports on the pipeline and team pages, with and without a
 * DM team or DM closer filter (docs/plans/phase-3-attribution.md §6.4). The
 * numbers were pinned against the bucket read on the copied columns; the
 * filtered paths now read `dealAttributions` and must keep them.
 */
import { afterEach, expect, it, vi } from "vitest";
import { attendanceStorageModes, type AttendanceStorage } from "../../tests/heldAttendanceFixtures";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";
import { recordBookingAttribution } from "../lib/attribution/dealAttributions";
import { requestMeetingProjection } from "../operations/meetingStats";

afterEach(() => vi.useRealTimers());

type Status = "scheduled" | "completed" | "canceled" | "no_show";

async function insertUser(ctx: MutationCtx, tenantId: Id<"tenants">, key: string) {
  return await ctx.db.insert("users", {
    tenantId,
    workosUserId: `user_${key}`,
    email: `${key}@example.com`,
    fullName: key,
    role: "closer",
    isActive: true,
  });
}

async function insertTeam(ctx: MutationCtx, tenantId: Id<"tenants">, slug: string) {
  return await ctx.db.insert("attributionTeams", {
    tenantId,
    slug,
    displayName: slug,
    utmSource: slug,
    normalizedUtmSource: slug,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
  });
}

async function insertDmCloser(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  slug: string,
  teamId: Id<"attributionTeams">,
  teamMemberId: Id<"teamMembers">,
) {
  return await ctx.db.insert("dmClosers", {
    tenantId,
    teamId,
    slug,
    displayName: slug,
    utmMedium: slug,
    normalizedUtmMedium: slug,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    teamMemberId,
  });
}

/**
 * Meetings over 2026-10-01 and 2026-10-02 (the range), plus one on either
 * side of it, across two teams and three DM closer records. D1a (team T1)
 * and D1b (team T2) share one team member. m6 is a follow-up on m1's deal
 * booked through a different DM closer and team. m12 has rows but was never
 * projected, so neither read counts it.
 */
async function seed(storage: AttendanceStorage = "completed") {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
  const harness = await bookingHarness();
  const { t, tenantId } = harness;
  const fixture = await t.run(async (ctx) => {
    await ctx.db.patch("tenants", tenantId, { meetingProjectionVersion: 2 });
    const closerA = (await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
      .unique())!._id;
    await ctx.db.patch("users", closerA, { fullName: "Closer A" });
    const closerB = await insertUser(ctx, tenantId, "Closer B");
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId,
      name: "Program",
      normalizedName: "program",
      createdAt: 0,
      updatedAt: 0,
      createdByUserId: closerA,
    });
    const t1 = await insertTeam(ctx, tenantId, "t1");
    const t2 = await insertTeam(ctx, tenantId, "t2");
    const shared = await ctx.db.insert("teamMembers", {
      tenantId,
      displayName: "Shared",
      createdAt: 0,
      updatedAt: 0,
    });
    const own = await ctx.db.insert("teamMembers", {
      tenantId,
      displayName: "Own",
      createdAt: 0,
      updatedAt: 0,
    });
    const d1a = await insertDmCloser(ctx, tenantId, "d1a", t1, shared);
    const d1b = await insertDmCloser(ctx, tenantId, "d1b", t2, shared);
    const d2 = await insertDmCloser(ctx, tenantId, "d2", t2, own);
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      ...qualifiedLifecycle(0),
      status: "active",
      firstSeenAt: 0,
      updatedAt: 0,
    });

    const opportunities = new Map<string, Id<"opportunities">>();
    const meetings = new Map<string, Id<"meetings">>();
    const book = async (
      key: string,
      at: string,
      closer: Id<"users">,
      status: Status,
      credit: { teamId?: Id<"attributionTeams">; dmCloserId?: Id<"dmClosers"> },
      options: { programId?: Id<"tenantPrograms">; deal?: string; project?: boolean } = {},
    ) => {
      const deal = options.deal ?? key;
      let opportunityId = opportunities.get(deal);
      if (!opportunityId) {
        opportunityId = await ctx.db.insert("opportunities", {
          tenantId,
          leadId,
          stage: "booked", outcome: "open",
          source: "calendly",
          assignedCloserId: closer,
          createdAt: 0,
          updatedAt: 0,
        });
        opportunities.set(deal, opportunityId);
      }
      const scheduledAt = Date.parse(at);
      const meetingId = await ctx.db.insert("meetings", {
        tenantId,
        opportunityId,
        assignedCloserId: closer,
        calendlyEventUri: `https://api.calendly.com/scheduled_events/${key}`,
        calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${key}/invitees/person`,
        scheduledAt,
        durationMinutes: 30,
        status: status === "completed" && (storage === "held" || (storage === "mixed" && Number(key.slice(1)) % 2 === 0)) ? "held" : status,
        heldMarkedAt: status === "completed" && (storage === "held" || (storage === "mixed" && Number(key.slice(1)) % 2 === 0)) ? scheduledAt : undefined,
        callClassification: options.deal ? "follow_up" : "new",
        createdAt: scheduledAt - 86_400_000,
        bookingProgramId: options.programId,
        attributionResolution: credit.teamId ? "mapped" : "none",
      });
      meetings.set(key, meetingId);
      const meeting = (await ctx.db.get("meetings", meetingId))!;
      await recordBookingAttribution(ctx, { meeting, credit });
      if (options.project !== false) {
        await requestMeetingProjection(ctx, tenantId, meetingId);
      }
    };

    await book("m1", "2026-10-01T12:00:00Z", closerA, "completed", { teamId: t1, dmCloserId: d1a }, { programId });
    await book("m2", "2026-10-01T13:00:00Z", closerA, "no_show", { teamId: t1, dmCloserId: d1a });
    await book("m3", "2026-10-01T14:00:00Z", closerB, "canceled", { teamId: t1, dmCloserId: d1a }, { programId });
    await book("m4", "2026-10-02T12:00:00Z", closerB, "completed", { teamId: t2, dmCloserId: d1b }, { programId });
    await book("m5", "2026-10-02T13:00:00Z", closerA, "scheduled", { teamId: t2, dmCloserId: d2 });
    await book("m6", "2026-10-02T14:00:00Z", closerA, "completed", { teamId: t2, dmCloserId: d2 }, { deal: "m1" });
    await book("m7", "2026-10-02T15:00:00Z", closerB, "completed", { teamId: t1 }, { programId });
    await book("m8", "2026-10-01T16:00:00Z", closerB, "scheduled", {});
    await book("m9", "2026-09-30T12:00:00Z", closerA, "completed", { teamId: t1, dmCloserId: d1a });
    await book("m10", "2026-10-03T00:00:00Z", closerA, "completed", { teamId: t1, dmCloserId: d1a });
    await book("m11", "2026-10-02T23:30:00Z", closerA, "no_show", { teamId: t1, dmCloserId: d1a }, { programId });
    await book("m12", "2026-10-01T18:00:00Z", closerA, "completed", { teamId: t1, dmCloserId: d1a }, { project: false });

    return { closerA, closerB, programId, t1, t2, d1a, d1b, d2, meetings: Object.fromEntries(meetings) };
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return { ...harness, ...fixture };
}

type Filters = {
  bookingProgramId?: Id<"tenantPrograms">;
  attributionTeamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
};

it.each(attendanceStorageModes)("keeps the pipeline show rate for every team, DM closer and program filter with %s rows", async (storage) => {
  const { admin, programId, t1, t2, d1a, d1b, d2 } = await seed(storage);
  const showRate = (filters: Filters) =>
    admin.query(api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions, {
      startDayKey: "2026-10-01",
      endDayKeyExclusive: "2026-10-03",
      ...filters,
    });
  const counts = (scheduled: number, shown: number, canceled: number, noShows: number) => ({
    scheduled,
    shown,
    canceled,
    noShows,
    resultsRecorded: shown + noShows,
    pastCalls: scheduled - canceled,
    showRate: shown + noShows > 0 ? shown / (shown + noShows) : null,
    noShowRate: shown + noShows > 0 ? noShows / (shown + noShows) : null,
    attendanceCountsPartial: false,
    truncated: false,
  });

  expect(await showRate({})).toEqual(counts(9, 4, 1, 2));
  expect(await showRate({ attributionTeamId: t1 })).toEqual(counts(5, 2, 1, 2));
  expect(await showRate({ attributionTeamId: t2 })).toEqual(counts(3, 2, 0, 0));
  // D1a and D1b share a team member; each record keeps its own bookings.
  expect(await showRate({ dmCloserId: d1a })).toEqual(counts(4, 1, 1, 2));
  expect(await showRate({ dmCloserId: d1b })).toEqual(counts(1, 1, 0, 0));
  // The follow-up m6 counts for its own DM closer, not its deal's first one.
  expect(await showRate({ dmCloserId: d2 })).toEqual(counts(2, 1, 0, 0));
  expect(await showRate({ attributionTeamId: t1, dmCloserId: d1a })).toEqual(counts(4, 1, 1, 2));
  expect(await showRate({ attributionTeamId: t1, dmCloserId: d1b })).toEqual(counts(0, 0, 0, 0));
  expect(await showRate({ attributionTeamId: t2, dmCloserId: d1b })).toEqual(counts(1, 1, 0, 0));
  expect(await showRate({ attributionTeamId: t2, dmCloserId: d2 })).toEqual(counts(2, 1, 0, 0));
  expect(await showRate({ bookingProgramId: programId })).toEqual(counts(5, 3, 1, 1));
  expect(await showRate({ bookingProgramId: programId, attributionTeamId: t1 })).toEqual(counts(4, 2, 1, 1));
  expect(await showRate({ bookingProgramId: programId, dmCloserId: d1a })).toEqual(counts(3, 1, 1, 1));
  expect(await showRate({ bookingProgramId: programId, dmCloserId: d2 })).toEqual(counts(0, 0, 0, 0));
});

it.each(attendanceStorageModes)("keeps the team operations dimensions for every team, DM closer and program filter with %s rows", async (storage) => {
  const { admin, closerA, closerB, programId, t1, t2, d1a, d1b, d2 } = await seed(storage);
  // Mid-day bounds: the report keys by the UTC day of each end, as the buckets do.
  const dimensions = async (filters: Filters) => {
    const result = await admin.query(api.reporting.teamPerformance.getTeamOperationsDimensions, {
      startDate: Date.parse("2026-10-01T06:00:00Z"),
      endDate: Date.parse("2026-10-03T06:00:00Z"),
      ...filters,
    });
    return {
      rows: result.rows.map(({ closerId, scheduled, completed, canceled, noShows }) => ({
        closerId,
        scheduled,
        completed,
        canceled,
        noShows,
      })),
      totals: result.totals,
      truncated: result.truncated,
    };
  };
  const row = (
    closerId: Id<"users">,
    scheduled: number,
    completed: number,
    canceled: number,
    noShows: number,
  ) => ({ closerId, scheduled, completed, canceled, noShows });
  const totals = (scheduled: number, completed: number, canceled: number, noShows: number) => ({
    scheduled,
    completed,
    canceled,
    noShows,
    notRecorded: scheduled - canceled - completed - noShows,
    resultsRecorded: completed + noShows,
    pastCalls: scheduled - canceled,
    showRate: completed + noShows > 0 ? completed / (completed + noShows) : null,
    noShowRate: completed + noShows > 0 ? noShows / (completed + noShows) : null,
  });

  expect(await dimensions({})).toEqual({
    rows: [row(closerA, 5, 2, 0, 2), row(closerB, 4, 2, 1, 0)],
    totals: totals(9, 4, 1, 2),
    truncated: false,
  });
  expect(await dimensions({ attributionTeamId: t1 })).toEqual({
    rows: [row(closerA, 3, 1, 0, 2), row(closerB, 2, 1, 1, 0)],
    totals: totals(5, 2, 1, 2),
    truncated: false,
  });
  expect(await dimensions({ attributionTeamId: t2 })).toEqual({
    rows: [row(closerA, 2, 1, 0, 0), row(closerB, 1, 1, 0, 0)],
    totals: totals(3, 2, 0, 0),
    truncated: false,
  });
  expect(await dimensions({ dmCloserId: d1a })).toEqual({
    rows: [row(closerA, 3, 1, 0, 2), row(closerB, 1, 0, 1, 0)],
    totals: totals(4, 1, 1, 2),
    truncated: false,
  });
  expect(await dimensions({ dmCloserId: d1b })).toEqual({
    rows: [row(closerB, 1, 1, 0, 0)],
    totals: totals(1, 1, 0, 0),
    truncated: false,
  });
  expect(await dimensions({ dmCloserId: d2 })).toEqual({
    rows: [row(closerA, 2, 1, 0, 0)],
    totals: totals(2, 1, 0, 0),
    truncated: false,
  });
  expect(await dimensions({ attributionTeamId: t1, dmCloserId: d1b })).toEqual({
    rows: [],
    totals: totals(0, 0, 0, 0),
    truncated: false,
  });
  expect(await dimensions({ attributionTeamId: t2, dmCloserId: d1b })).toEqual({
    rows: [row(closerB, 1, 1, 0, 0)],
    totals: totals(1, 1, 0, 0),
    truncated: false,
  });
  expect(await dimensions({ bookingProgramId: programId, attributionTeamId: t1 })).toEqual({
    rows: [row(closerA, 2, 1, 0, 1), row(closerB, 2, 1, 1, 0)],
    totals: totals(4, 2, 1, 1),
    truncated: false,
  });
  expect(await dimensions({ bookingProgramId: programId, dmCloserId: d1a })).toEqual({
    rows: [row(closerA, 2, 1, 0, 1), row(closerB, 1, 0, 1, 0)],
    totals: totals(3, 1, 1, 1),
    truncated: false,
  });
});

it("reports a filtered range past 2,000 credited meetings as truncated", async () => {
  const { t, tenantId, admin, t1, meetings } = await seed();
  const range = { startDayKey: "2026-10-01", endDayKeyExclusive: "2026-10-03" };
  await t.run(async (ctx) => {
    const meeting = (await ctx.db.get("meetings", meetings.m1))!;
    for (let i = 0; i < 2000; i++) {
      await ctx.db.insert("dealAttributions", {
        tenantId,
        opportunityId: meeting.opportunityId,
        role: "dm_team",
        teamId: t1,
        source: { kind: "booking_utm" },
        meetingId: meeting._id,
        meetingScheduledAt: Date.parse("2026-10-01T00:00:00Z"),
        attributedAt: 0,
        createdAt: 0,
      });
    }
  });
  const result = await admin.query(
    api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions,
    { ...range, attributionTeamId: t1 },
  );
  expect(result.truncated).toBe(true);
  // The first 2,000 rows are the extra ones, all on m1, which counts once.
  expect(result.scheduled).toBe(1);
  expect(
    (
      await admin.query(
        api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions,
        range,
      )
    ).truncated,
  ).toBe(false);
});
