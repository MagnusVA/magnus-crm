import { afterEach, describe, expect, it, vi } from "vitest";
import { bookingHarness, qualifiedLifecycle } from "../../../tests/bookingHarness";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { mergePipelineBacklogAndLoss, mergeSchedulingShowRate } from "./pipeline";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { recordBookingAttribution } from "../../lib/attribution/dealAttributions";
import { requestMeetingProjection } from "../../operations/meetingStats";

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
async function createFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const harness = await bookingHarness();
  const { t, tenantId } = harness;
  const fixture = await t.run(async (ctx) => {
    await ctx.db.patch("tenants", tenantId, { meetingProjectionVersion: 2 });
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(10);
    const adminId = users.find((user) => user.role === "tenant_admin")!._id;
    const closerId = users.find((user) => user.role === "closer")!._id;
    await ctx.db.patch("users", closerId, { fullName: "Carla Closer" });
    await ctx.db.patch("users", adminId, { fullName: "Ana Admin" });
    const removedId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_gone",
      email: "gone@example.com",
      role: "closer",
      isActive: false,
    });
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId,
      name: "Program",
      normalizedName: "program",
      createdAt: 0,
      updatedAt: 0,
      createdByUserId: adminId,
    });
    const otherProgramId = await ctx.db.insert("tenantPrograms", {
      tenantId,
      name: "Other",
      normalizedName: "other",
      createdAt: 0,
      updatedAt: 0,
      createdByUserId: adminId,
    });
    const teamId = await ctx.db.insert("attributionTeams", {
      tenantId,
      slug: "t1",
      displayName: "t1",
      utmSource: "t1",
      normalizedUtmSource: "t1",
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    });
    const teamMemberId = await ctx.db.insert("teamMembers", {
      tenantId,
      displayName: "Member",
      createdAt: 0,
      updatedAt: 0,
    });
    const dmCloserId = await ctx.db.insert("dmClosers", {
      tenantId,
      teamId,
      slug: "d1",
      displayName: "d1",
      utmMedium: "d1",
      normalizedUtmMedium: "d1",
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
      teamMemberId,
    });
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      ...qualifiedLifecycle(0),
      status: "active",
      firstSeenAt: 0,
      updatedAt: 0,
    });

    const deal = (fields: Partial<Doc<"opportunities">> = {}) =>
      ctx.db.insert("opportunities", {
        tenantId,
        leadId,
        stage: "booked",
        outcome: "open",
        source: "calendly",
        assignedCloserId: closerId,
        createdAt: 0,
        updatedAt: 0,
        latestActivityAt: 0,
        ...fields,
      });
    const lostAt = Date.parse("2026-10-01T15:00:00Z");
    const lost = { stage: "closed" as const, outcome: "lost" as const };
    await deal({
      ...lost,
      lostAt,
      latestActivityAt: lostAt,
      lostByUserId: adminId,
      lostReason: "Too expensive",
    });
    await deal({
      ...lost,
      lostAt: lostAt + 1,
      latestActivityAt: lostAt + 1,
      lostByUserId: closerId,
    });
    await deal({
      ...lost,
      lostAt: lostAt + DAY,
      latestActivityAt: lostAt + DAY,
      lostByUserId: closerId,
    });
    await deal({
      ...lost,
      lostAt: lostAt + 3,
      latestActivityAt: lostAt + 3,
      lostByUserId: removedId,
    });
    // A person's loss with no recorded loser, the system's expiry, and a
    // loss outside the range.
    await deal({
      ...lost,
      lostAt: lostAt + 4,
      latestActivityAt: lostAt + 4,
      lostReason: "Went quiet",
    });
    await deal({ ...lost, lostAt: lostAt + 5, latestActivityAt: lostAt + 5, lostReason: "stale" });
    await deal({
      ...lost,
      lostAt: browserRange.toMs + DAY,
      latestActivityAt: browserRange.toMs + DAY,
      lostByUserId: adminId,
    });

    const followUpDeal = await deal();
    const followUp = (fields: Partial<Doc<"followUps">>) =>
      ctx.db.insert("followUps", {
        tenantId,
        opportunityId: followUpDeal,
        leadId,
        closerId,
        type: "manual_reminder",
        reason: "closer_initiated",
        status: "pending",
        createdAt: 0,
        ...fields,
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
      options: {
        programId?: Id<"tenantPrograms">;
        noShowSource?: Doc<"meetings">["noShowSource"];
        credit?: boolean;
        soldProgramId?: Id<"tenantPrograms">;
      } = {},
    ) => {
      const opportunityId = await deal({ soldProgramId: options.soldProgramId });
      const scheduledAt = Date.parse(at);
      const meetingId = await ctx.db.insert("meetings", {
        tenantId,
        opportunityId,
        assignedCloserId: closerId,
        calendlyEventUri: `https://api.calendly.com/scheduled_events/${key}`,
        calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${key}/invitees/person`,
        scheduledAt,
        durationMinutes: 30,
        status,
        createdAt: scheduledAt - DAY,
        bookingProgramId: options.programId,
        noShowSource: options.noShowSource,
        attributionResolution: options.credit ? "mapped" : "none",
      });
      const meeting = (await ctx.db.get("meetings", meetingId))!;
      await recordBookingAttribution(ctx, {
        meeting,
        credit: options.credit ? { teamId, dmCloserId } : {},
      });
      await requestMeetingProjection(ctx, tenantId, meetingId);
    };
    await book("m1", "2026-10-01T12:00:00Z", "held", {
      programId,
      credit: true,
      soldProgramId: programId,
    });
    await book("m2", "2026-10-01T13:00:00Z", "no_show", { noShowSource: "closer", credit: true });
    await book("m3", "2026-10-01T14:00:00Z", "no_show", {
      programId,
      noShowSource: "calendly_webhook",
    });
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

describe("Pipeline across the split", () => {
  it("adds losses and no-shows while taking the current backlog from today", async () => {
    const { t } = await createFixture();
    const split = Date.parse("2026-10-02T06:00:00Z");
    const answers = await expectMergedAnswer({
      t,
      identity,
      live: api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
      history: { startDate: browserRange.fromMs, endDate: split },
      today: { startDate: split, endDate: browserRange.toMs },
      whole: { startDate: browserRange.fromMs, endDate: browserRange.toMs },
      merge: mergePipelineBacklogAndLoss,
    });
    expect(answers.history.noShowSourceSplit.closer).toBeGreaterThan(0);
    expect(answers.today.noShowSourceSplit.none).toBeGreaterThan(0);
    expect(answers.history.lossAttribution.closer).toBeGreaterThan(0);
    expect(answers.today.lossAttribution.closer).toBeGreaterThan(0);
    expect(answers.whole.unresolvedRemindersCount).toBe(3);
    const stale = {
      ...answers.history,
      unresolvedRemindersCount: 999,
      unresolvedReminderSplit: { closer: 999, admin: 0, system: 0 },
      isUnresolvedRemindersTruncated: true,
      isNoShowSourceTruncated: true,
      isLossAttributionTruncated: true,
    };
    const merged = mergePipelineBacklogAndLoss(stale, answers.today);
    expect(merged).toMatchObject({
      unresolvedRemindersCount: 3,
      unresolvedReminderSplit: answers.today.unresolvedReminderSplit,
      isUnresolvedRemindersTruncated: false,
      isNoShowSourceTruncated: true,
      isLossAttributionTruncated: true,
    });
  });

  it("merges show rates for every page filter and preserves attendance flags", async () => {
    const { t, programId, teamId, dmCloserId } = await createFixture();
    for (const filters of [
      {},
      { bookingProgramId: programId },
      { attributionTeamId: teamId },
      { dmCloserId },
      { bookingProgramId: programId, attributionTeamId: teamId, dmCloserId },
    ]) {
      const answers = await expectMergedAnswer({
        t,
        identity,
        live: api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions,
        history: { startDayKey: "2026-10-01", endDayKeyExclusive: "2026-10-02", ...filters },
        today: { startDayKey: "2026-10-02", endDayKeyExclusive: "2026-10-03", ...filters },
        whole: { startDayKey: "2026-10-01", endDayKeyExclusive: "2026-10-03", ...filters },
        merge: mergeSchedulingShowRate,
      });
      expect(answers.history.scheduled).toBeGreaterThan(0);
      expect(answers.today.scheduled).toBeGreaterThan(0);
      expect(
        mergeSchedulingShowRate(
          { ...answers.history, truncated: true, attendanceCountsPartial: true },
          answers.today,
        ),
      ).toMatchObject({ truncated: true, attendanceCountsPartial: true });
    }
  });
});
