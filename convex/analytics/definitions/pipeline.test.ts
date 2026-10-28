import { afterEach, describe, expect, it, vi } from "vitest";
import { addBusinessDays, businessDateForInstant, businessDayStart, DEFAULT_BUSINESS_DAY } from "../../../lib/businessDay";
import { bookingHarness, qualifiedLifecycle } from "../../../tests/bookingHarness";
import { expectSameAnswer } from "../../../tests/analyticsParity";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { recordBookingAttribution } from "../../lib/attribution/dealAttributions";
import { requestMeetingProjection } from "../../operations/meetingStats";
import { isPersonLoss } from "../../reporting/lib/outcomeDerivation";

afterEach(() => vi.useRealTimers());

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-04T00:00:00Z");
const identity = { subject: "user_admin", org_id: "org_test" };

// Backlog and loss run on the browser day; the show rate on the business day.
const browserRange = {
  startDate: "2026-10-01",
  endDateInclusive: "2026-10-02",
  fromMs: Date.parse("2026-10-01T06:00:00Z"),
  toMs: Date.parse("2026-10-03T06:00:00Z"),
  timeZone: "America/Tegucigalpa",
  dayStartHour: 0,
};
const businessRange = {
  startDate: "2026-10-01",
  endDateInclusive: "2026-10-02",
  fromMs: businessDayStart("2026-10-01", DEFAULT_BUSINESS_DAY),
  toMs: businessDayStart("2026-10-03", DEFAULT_BUSINESS_DAY),
  timeZone: DEFAULT_BUSINESS_DAY.timeZone,
  dayStartHour: DEFAULT_BUSINESS_DAY.dayStartHour,
};

async function createFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const harness = await bookingHarness();
  const { t, tenantId } = harness;
  const fixture = await t.run(async (ctx) => {
    await ctx.db.patch("tenants", tenantId, { meetingProjectionVersion: 2 });
    const users = await ctx.db.query("users").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(10);
    const adminId = users.find((user) => user.role === "tenant_admin")!._id;
    const closerId = users.find((user) => user.role === "closer")!._id;
    await ctx.db.patch("users", closerId, { fullName: "Carla Closer" });
    await ctx.db.patch("users", adminId, { fullName: "Ana Admin" });
    const removedId = await ctx.db.insert("users", {
      tenantId, workosUserId: "user_gone", email: "gone@example.com", role: "closer", isActive: false,
    });
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId, name: "Program", normalizedName: "program", createdAt: 0, updatedAt: 0, createdByUserId: adminId,
    });
    const otherProgramId = await ctx.db.insert("tenantPrograms", {
      tenantId, name: "Other", normalizedName: "other", createdAt: 0, updatedAt: 0, createdByUserId: adminId,
    });
    const teamId = await ctx.db.insert("attributionTeams", {
      tenantId, slug: "t1", displayName: "t1", utmSource: "t1", normalizedUtmSource: "t1", isActive: true, createdAt: 0, updatedAt: 0,
    });
    const teamMemberId = await ctx.db.insert("teamMembers", { tenantId, displayName: "Member", createdAt: 0, updatedAt: 0 });
    const dmCloserId = await ctx.db.insert("dmClosers", {
      tenantId, teamId, slug: "d1", displayName: "d1", utmMedium: "d1", normalizedUtmMedium: "d1", isActive: true,
      createdAt: 0, updatedAt: 0, teamMemberId,
    });
    const leadId = await ctx.db.insert("leads", {
      tenantId, ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0,
    });

    const deal = (fields: Partial<Doc<"opportunities">> = {}) =>
      ctx.db.insert("opportunities", {
        tenantId, leadId, stage: "booked", outcome: "open", source: "calendly", assignedCloserId: closerId,
        createdAt: 0, updatedAt: 0, latestActivityAt: 0, ...fields,
      });
    const lostAt = Date.parse("2026-10-01T15:00:00Z");
    const lost = { stage: "closed" as const, outcome: "lost" as const };
    await deal({ ...lost, lostAt, latestActivityAt: lostAt, lostByUserId: adminId, lostReason: "Too expensive" });
    await deal({ ...lost, lostAt: lostAt + 1, latestActivityAt: lostAt + 1, lostByUserId: closerId });
    await deal({ ...lost, lostAt: lostAt + 2, latestActivityAt: lostAt + 2, lostByUserId: closerId });
    await deal({ ...lost, lostAt: lostAt + 3, latestActivityAt: lostAt + 3, lostByUserId: removedId });
    // A person's loss with no recorded loser, the system's expiry, and a
    // loss outside the range.
    await deal({ ...lost, lostAt: lostAt + 4, latestActivityAt: lostAt + 4, lostReason: "Went quiet" });
    await deal({ ...lost, lostAt: lostAt + 5, latestActivityAt: lostAt + 5, lostReason: "stale" });
    await deal({ ...lost, lostAt: browserRange.toMs + DAY, latestActivityAt: browserRange.toMs + DAY, lostByUserId: adminId });

    const followUpDeal = await deal();
    const followUp = (fields: Partial<Doc<"followUps">>) =>
      ctx.db.insert("followUps", {
        tenantId, opportunityId: followUpDeal, leadId, closerId, type: "manual_reminder",
        reason: "closer_initiated", status: "pending", createdAt: 0, ...fields,
      });
    await followUp({ createdSource: "closer", createdAt: 1 });
    await followUp({ createdSource: "admin", createdAt: 2 });
    await followUp({ createdAt: 3 });
    await followUp({ type: "scheduling_link", createdAt: 4 });
    await followUp({ status: "completed", createdAt: 5 });

    const book = async (
      key: string,
      at: string,
      status: Doc<"meetings">["status"],
      options: { programId?: Id<"tenantPrograms">; noShowSource?: Doc<"meetings">["noShowSource"]; credit?: boolean; soldProgramId?: Id<"tenantPrograms"> } = {},
    ) => {
      const opportunityId = await deal({ soldProgramId: options.soldProgramId });
      const scheduledAt = Date.parse(at);
      const meetingId = await ctx.db.insert("meetings", {
        tenantId, opportunityId, assignedCloserId: closerId,
        calendlyEventUri: `https://api.calendly.com/scheduled_events/${key}`,
        calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${key}/invitees/person`,
        scheduledAt, durationMinutes: 30, status, createdAt: scheduledAt - DAY,
        bookingProgramId: options.programId, noShowSource: options.noShowSource,
        attributionResolution: options.credit ? "mapped" : "none",
      });
      const meeting = (await ctx.db.get("meetings", meetingId))!;
      await recordBookingAttribution(ctx, { meeting, credit: options.credit ? { teamId, dmCloserId } : {} });
      await requestMeetingProjection(ctx, tenantId, meetingId);
    };
    await book("m1", "2026-10-01T12:00:00Z", "held", { programId, credit: true, soldProgramId: programId });
    await book("m2", "2026-10-01T13:00:00Z", "no_show", { noShowSource: "closer", credit: true });
    await book("m3", "2026-10-01T14:00:00Z", "no_show", { programId, noShowSource: "calendly_webhook" });
    await book("m4", "2026-10-02T12:00:00Z", "no_show", { programId });
    await book("m5", "2026-10-02T13:00:00Z", "canceled", { programId, credit: true });
    await book("m6", "2026-10-02T14:00:00Z", "scheduled", { programId, credit: true });
    await book("m7", "2026-10-02T15:00:00Z", "scheduled", { programId: otherProgramId });
    await book("m8", "2026-10-02T16:00:00Z", "held", { programId: otherProgramId });
    // Outside the range on both day definitions.
    await book("m9", "2026-09-30T12:00:00Z", "no_show", { noShowSource: "closer", credit: true });
    await book("m10", "2026-10-03T12:00:00Z", "held", { programId, credit: true });
    return { programId, teamId, dmCloserId };
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return { ...harness, ...fixture };
}

// What the report's SQL returns for these documents.
async function backlogRows(t: Awaited<ReturnType<typeof createFixture>>["t"]) {
  return await t.run(async (ctx) => {
    const followUps = (await ctx.db.query("followUps").take(100))
      .filter((followUp) => followUp.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime);
    const noShows = new Map<string | null, number>();
    for (const meeting of await ctx.db.query("meetings").take(100)) {
      if (meeting.status !== "no_show" || meeting.scheduledAt < browserRange.fromMs || meeting.scheduledAt >= browserRange.toMs) continue;
      const source = meeting.noShowSource ?? null;
      noShows.set(source, (noShows.get(source) ?? 0) + 1);
    }
    const losses = (await ctx.db.query("opportunities").take(100))
      .filter((deal) => deal.lostAt !== undefined && deal.lostAt >= browserRange.fromMs && deal.lostAt < browserRange.toMs && isPersonLoss(deal))
      .sort((a, b) => a.lostAt! - b.lostAt!);
    const lossCounts = new Map<string | null, number>();
    for (const deal of losses) lossCounts.set(deal.lostByUserId ?? null, (lossCounts.get(deal.lostByUserId ?? null) ?? 0) + 1);
    return {
      pending_follow_ups: followUps.map((followUp) => ({ type: followUp.type, created_source: followUp.createdSource ?? null })),
      no_show_sources: [...noShows].map(([no_show_source, count]) => ({ no_show_source, count })),
      losses: [...lossCounts].map(([lost_by_user_id, count]) => ({ lost_by_user_id, count })),
    };
  });
}

async function showRateRows(
  t: Awaited<ReturnType<typeof createFixture>>["t"],
  filters: { bookingProgramId?: Id<"tenantPrograms">; credited?: boolean },
) {
  return await t.run(async (ctx: MutationCtx) => {
    const credited = new Set<string>();
    for (const row of await ctx.db.query("dealAttributions").take(100)) {
      if (row.role === "dm_closer" && row.meetingId) credited.add(row.meetingId);
    }
    const buckets = new Map<string, Record<string, unknown> & { count: number }>();
    for (const meeting of await ctx.db.query("meetings").take(100)) {
      if (meeting.scheduledAt < businessRange.fromMs || meeting.scheduledAt >= businessRange.toMs) continue;
      if (filters.bookingProgramId && meeting.bookingProgramId !== filters.bookingProgramId) continue;
      if (filters.credited && !credited.has(meeting._id)) continue;
      const deal = (await ctx.db.get("opportunities", meeting.opportunityId))!;
      const dayKey = businessDateForInstant(meeting.scheduledAt, DEFAULT_BUSINESS_DAY);
      const scheduled = meeting.status === "scheduled";
      const row = {
        meeting_status: meeting.status,
        booking_program_id: meeting.bookingProgramId ?? null,
        day_key: dayKey,
        assigned_closer_id: meeting.assignedCloserId,
        sold_program_id: scheduled ? (deal.soldProgramId ?? null) : null,
        meeting_id: scheduled && filters.credited ? meeting._id : null,
      };
      const key = JSON.stringify(scheduled ? row : [row.meeting_status, row.booking_program_id]);
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
        if (!scheduled && dayKey < String(existing.day_key)) existing.day_key = dayKey;
      } else buckets.set(key, { ...row, count: 1 });
    }
    return { meeting_counts: [...buckets.values()] };
  });
}

describe("Pipeline Health from ClickHouse rows", () => {
  it("matches the backlog and loss reader", async () => {
    const fixture = await createFixture();
    const live = await expectSameAnswer({
      t: fixture.t,
      identity,
      tenantId: fixture.tenantId,
      range: browserRange,
      rows: await backlogRows(fixture.t),
      reportId: "pipeline.backlog_and_loss",
      live: api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
      liveArgs: { startDate: browserRange.fromMs, endDate: browserRange.toMs },
      filters: {},
    });
    expect(live).toMatchObject({
      unresolvedRemindersCount: 3,
      unresolvedReminderSplit: { closer: 1, admin: 1, system: 1 },
      noShowSourceSplit: { closer: 1, calendly_webhook: 1, none: 1 },
      lossAttribution: { admin: 1, closer: 3, unknown: 1 },
    });
    expect(live.lossAttribution.byActor.map((actor: { count: number }) => actor.count)).toEqual([2, 1, 1]);
  });

  it("matches the show rate with and without the program and DM closer filters", async () => {
    const fixture = await createFixture();
    const liveRange = {
      startDayKey: businessRange.startDate,
      endDayKeyExclusive: addBusinessDays(businessRange.endDateInclusive, 1),
    };
    const base = { t: fixture.t, identity, tenantId: fixture.tenantId, range: businessRange, reportId: "pipeline.show_rate", live: api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions };
    const all = await expectSameAnswer({
      ...base,
      rows: await showRateRows(fixture.t, {}),
      liveArgs: liveRange,
      filters: { bookingProgramId: null, attributionTeamId: null, dmCloserId: null },
    });
    await expectSameAnswer({
      ...base,
      rows: await showRateRows(fixture.t, { bookingProgramId: fixture.programId }),
      liveArgs: { ...liveRange, bookingProgramId: fixture.programId },
      filters: { bookingProgramId: fixture.programId, attributionTeamId: null, dmCloserId: null },
    });
    const credited = await expectSameAnswer({
      ...base,
      rows: await showRateRows(fixture.t, { credited: true }),
      liveArgs: { ...liveRange, attributionTeamId: fixture.teamId, dmCloserId: fixture.dmCloserId },
      filters: { bookingProgramId: null, attributionTeamId: fixture.teamId, dmCloserId: fixture.dmCloserId },
    });
    expect(all).toMatchObject({ scheduled: 8, shown: 2, canceled: 1, noShows: 3 });
    expect(credited).toMatchObject({ scheduled: 4, shown: 1, canceled: 1, noShows: 1 });
  });
});
