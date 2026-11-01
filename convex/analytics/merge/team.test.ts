import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { businessDayStart, DEFAULT_BUSINESS_DAY } from "../../../lib/businessDay";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { bookingHarness, qualifiedLifecycle } from "../../../tests/bookingHarness";
import { recordBookingAttribution } from "../../lib/attribution/dealAttributions";
import { insertMeetingAggregate } from "../../reporting/writeHooks";
import { mergeTeamActions, mergeTeamMetrics, mergeTeamOperations, mergeTeamOutcomes } from "./team";

const day = DEFAULT_BUSINESS_DAY;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-04T20:00:00Z");
const identity = { subject: "user_admin", org_id: "org_test" };
const at = (date: string, hours: number) => businessDayStart(date, day) + hours * HOUR;
afterEach(() => vi.useRealTimers());

async function createFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  const { t, tenantId } = harness;
  await t.run(async (ctx) => {
    await ctx.db.patch("tenants", tenantId, { meetingProjectionVersion: 2 });
    const adminId = (await ctx.db.query("users").withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin")).unique())!._id;
    const closerA = (await ctx.db.query("users").withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer")).unique())!._id;
    await ctx.db.patch("users", closerA, { fullName: "Closer A" });
    const user = (key: string, isActive: boolean) =>
      ctx.db.insert("users", { tenantId, workosUserId: `user_${key}`, email: `${key}@example.invalid`, fullName: key, role: "closer", isActive });
    const closerB = await user("Closer B", true);
    const former = await user("Former", false);
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId, name: "Program", normalizedName: "program", createdAt: 0, updatedAt: 0, createdByUserId: adminId,
    });
    const team = (slug: string) =>
      ctx.db.insert("attributionTeams", {
        tenantId, slug, displayName: slug, utmSource: slug, normalizedUtmSource: slug, isActive: true, createdAt: 0, updatedAt: 0,
      });
    const t1 = await team("t1");
    const t2 = await team("t2");
    const member = (displayName: string) => ctx.db.insert("teamMembers", { tenantId, displayName, createdAt: 0, updatedAt: 0 });
    const shared = await member("Shared");
    const own = await member("Own");
    const dmCloser = (slug: string, teamId: Id<"attributionTeams">, teamMemberId: Id<"teamMembers">) =>
      ctx.db.insert("dmClosers", {
        tenantId, teamId, slug, displayName: slug, utmMedium: slug, normalizedUtmMedium: slug,
        isActive: true, createdAt: 0, updatedAt: 0, teamMemberId,
      });
    const d1a = await dmCloser("d1a", t1, shared);
    const d1b = await dmCloser("d1b", t2, shared);
    const d2 = await dmCloser("d2", t2, own);
    const leadId = await ctx.db.insert("leads", {
      tenantId, ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0,
    });
    const deal = (fields: Partial<Doc<"opportunities">>) =>
      ctx.db.insert("opportunities", {
        tenantId, leadId, stage: "booked", outcome: "open", source: "calendly",
        assignedCloserId: closerA, createdAt: 0, updatedAt: 0, ...fields,
      });
    const booked = await deal({});
    const paid = await deal({ soldProgramId: programId, soldProgramName: "Program" });
    const lostByPerson = await deal({ stage: "closed", outcome: "lost", lostReason: "Budget", lostByUserId: closerA });
    const lostBySystem = await deal({ stage: "closed", outcome: "lost", lostReason: "no_show" });
    const followWithLink = await deal({ stage: "follow_up" });
    const followWithoutLink = await deal({ stage: "follow_up" });

    let index = 0;
    const meeting = async (
      opportunityId: Id<"opportunities">,
      assignedCloserId: Id<"users">,
      scheduledAt: number,
      status: Doc<"meetings">["status"],
      options: {
        followUp?: boolean;
        programId?: Id<"tenantPrograms">;
        credit?: { teamId?: Id<"attributionTeams">; dmCloserId?: Id<"dmClosers"> };
        rescheduledFromMeetingId?: Id<"meetings">;
      } = {},
    ) => {
      index += 1;
      const meetingId = await ctx.db.insert("meetings", {
        tenantId,
        opportunityId,
        assignedCloserId,
        calendlyEventUri: `https://api.calendly.com/scheduled_events/m${index}`,
        calendlyInviteeUri: `https://api.calendly.com/scheduled_events/m${index}/invitees/person`,
        scheduledAt,
        durationMinutes: 30,
        status,
        ...(status === "held" ? { heldMarkedAt: scheduledAt } : {}),
        // m1 has no classification, so it counts as new.
        ...(index === 1 ? {} : { callClassification: options.followUp ? "follow_up" as const : "new" as const }),
        createdAt: scheduledAt - DAY,
        ...(options.programId ? { bookingProgramId: options.programId, bookingProgramName: "Program" } : {}),
        ...(options.rescheduledFromMeetingId ? { rescheduledFromMeetingId: options.rescheduledFromMeetingId } : {}),
        attributionResolution: options.credit?.teamId ? "mapped" : "none",
      });
      const doc = await insertMeetingAggregate(ctx, meetingId);
      await recordBookingAttribution(ctx, { meeting: doc, credit: options.credit ?? {} });
      return meetingId;
    };

    await meeting(paid, closerA, at("2026-09-28", 10), "held", { programId, credit: { teamId: t1, dmCloserId: d1a } });
    await meeting(booked, closerA, at("2026-09-29", 11), "no_show", { credit: { teamId: t1, dmCloserId: d1a } });
    const canceled = await meeting(booked, closerB, at("2026-09-29", 12), "canceled", { programId, credit: { teamId: t1 } });
    await meeting(booked, closerB, at("2026-09-30", 9), "held", { followUp: true, credit: { teamId: t2, dmCloserId: d1b }, rescheduledFromMeetingId: canceled });
    const lostMeeting = await meeting(lostByPerson, closerA, at("2026-10-01", 10), "held", { credit: { teamId: t2, dmCloserId: d2 } });
    await ctx.db.patch("opportunities", lostByPerson, { latestMeetingId: lostMeeting });
    const systemLoss = await meeting(lostBySystem, closerB, at("2026-10-01", 15), "no_show");
    await ctx.db.patch("opportunities", lostBySystem, { latestMeetingId: systemLoss });
    await meeting(followWithLink, closerA, at("2026-10-02", 9), "held", { followUp: true, credit: { teamId: t1, dmCloserId: d1a } });
    await meeting(followWithoutLink, closerB, at("2026-10-03", 10), "held", { programId, credit: { teamId: t1, dmCloserId: d1a } });
    // Never recorded: one long past, one in the attendance window, one that
    // ended today and one still to come. The first is rescheduled by the second.
    const unrecorded = await meeting(booked, closerA, at("2026-09-30", 10), "scheduled", { credit: { teamId: t1, dmCloserId: d1a } });
    await meeting(booked, closerA, at("2026-10-03", 22), "scheduled", { followUp: true, credit: { teamId: t1, dmCloserId: d1a }, rescheduledFromMeetingId: unrecorded });
    // Today's two share a bucket; only the one that ended is credited.
    await meeting(booked, closerB, at("2026-10-04", 3), "scheduled", { credit: { teamId: t2, dmCloserId: d2 } });
    await meeting(booked, closerB, at("2026-10-04", 16), "scheduled");
    await meeting(booked, former, at("2026-10-01", 12), "held", { programId });
    const todayWon = await deal({ stage: "closed", outcome: "won" });
    await meeting(todayWon, closerA, at("2026-10-04", 4), "held", { programId, credit: { teamId: t1, dmCloserId: d1a } });
    // Outside the range.
    await meeting(booked, closerA, at("2026-09-27", 12), "held", { credit: { teamId: t1, dmCloserId: d1a } });
    await meeting(paid, closerB, at("2026-10-05", 2), "held");

    const pay = (fields: Partial<Doc<"paymentRecords">>) =>
      ctx.db.insert("paymentRecords", {
        tenantId, amountMinor: 100_000, currency: "USD", recordedByUserId: adminId, programId, programName: "Program",
        paymentType: "pif", status: "verified", recordedAt: at("2026-09-29", 4), origin: "closer_meeting", ...fields,
      });
    await pay({ opportunityId: paid, attributedCloserId: closerA, amountMinor: 250_000 });
    await pay({ opportunityId: todayWon, attributedCloserId: closerA, recordedAt: at("2026-10-04", 5) });
    await pay({ opportunityId: paid, attributedCloserId: closerA, recordedByUserId: closerA, recordedAt: at("2026-10-02", 5) });
    await pay({ opportunityId: booked, attributedCloserId: closerB, status: "disputed" });
    await pay({ opportunityId: followWithoutLink, attributedCloserId: closerB, recordedAt: at("2026-09-27", 5) });

    const followUp = (opportunityId: Id<"opportunities">, status: Doc<"followUps">["status"]) =>
      ctx.db.insert("followUps", {
        tenantId, opportunityId, leadId, closerId: closerA, type: "scheduling_link",
        reason: "no_show_follow_up", status, createdAt: at("2026-10-02", 12),
      });
    await followUp(followWithLink, "pending");
    await followUp(followWithoutLink, "expired");

    const event = (actorUserId: Id<"users"> | undefined, source: Doc<"domainEvents">["source"], occurredAt: number) =>
      ctx.db.insert("domainEvents", {
        tenantId, entityType: "meeting", entityId: "m", eventType: "meeting.held", occurredAt, source,
        ...(actorUserId ? { actorUserId } : {}),
      });
    await event(closerA, "closer", at("2026-10-04", 3));
    // B acts first and ties A, so B leads.
    await event(closerB, "closer", at("2026-09-28", 2));
    await event(closerA, "closer", at("2026-09-28", 3));
    await event(closerA, "closer", at("2026-09-29", 3));
    await event(closerB, "closer", at("2026-10-01", 3));
    await event(former, "closer", at("2026-10-02", 3));
    await event(closerA, "pipeline", at("2026-10-02", 4));
    await event(undefined, "closer", at("2026-10-02", 5));
    await event(closerA, "closer", at("2026-09-27", 3));
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.setSystemTime(NOW);
  const docs = await t.run(async (ctx) => ({
    meetings: await ctx.db.query("meetings").take(100),
    deals: await ctx.db.query("opportunities").take(100),
    attributions: await ctx.db.query("dealAttributions").take(200),
    dmClosers: await ctx.db.query("dmClosers").take(10),
    teams: await ctx.db.query("attributionTeams").take(10),
    programs: await ctx.db.query("tenantPrograms").take(10),
    payments: await ctx.db.query("paymentRecords").take(100),
    followUps: await ctx.db.query("followUps").take(100),
    events: await ctx.db.query("domainEvents").take(200),
  }));
  return { t, tenantId, ...docs };
}


const windows = {
  history: { startDate: at("2026-09-28", 0), endDate: at("2026-10-04", 0) },
  today: { startDate: at("2026-10-04", 0), endDate: at("2026-10-05", 0) },
  whole: { startDate: at("2026-09-28", 0), endDate: at("2026-10-05", 0) },
};

describe("Team across the split", () => {
  it("merges metrics and cohort counts, outcomes, and filtered operations", async () => {
    const fixture = await createFixture();
    const { t } = fixture;
    const metrics = await expectMergedAnswer({ t, identity, live: api.reporting.teamPerformance.getTeamPerformanceMetrics, ...windows, merge: mergeTeamMetrics });
    expect(metrics.history.teamTotals.cohortDeals).toBeGreaterThan(0);
    expect(metrics.today.teamTotals.cohortDeals).toBeGreaterThan(0);
    expect(metrics.whole.teamTotals.overallCloseRate).toBeCloseTo(metrics.whole.teamTotals.wonDeals! / metrics.whole.teamTotals.cohortDeals!);
    const outcomes = await expectMergedAnswer({ t, identity, live: api.reporting.teamOutcomes.getTeamOutcomeMix, ...windows, merge: mergeTeamOutcomes });
    expect(outcomes.history.teamOutcome.sold).toBeGreaterThan(0);
    expect(outcomes.today.teamOutcome.sold).toBeGreaterThan(0);
    const history = { ...metrics.history, isCloseRateCohortTruncated: true };
    const capped = mergeTeamMetrics(history, metrics.today);
    expect(capped.teamTotals.overallCloseRate).toBeNull();
    expect(capped.closers.every((row) => row.closeRate === null && row.cohortDeals === null && row.wonDeals === null)).toBe(true);
    const filters = [
      {},
      { bookingProgramId: fixture.programs[0]._id },
      { attributionTeamId: fixture.teams[0]._id },
      { dmCloserId: fixture.dmClosers[0]._id },
      { attributionTeamId: fixture.teams[0]._id, dmCloserId: fixture.dmClosers[0]._id },
    ];
    for (const filter of filters) {
      const answer = await expectMergedAnswer({
        t, identity, live: api.reporting.teamPerformance.getTeamOperationsDimensions,
        history: { startDayKey: "2026-09-28", endDayKeyExclusive: "2026-10-04", ...filter },
        today: { startDayKey: "2026-10-04", endDayKeyExclusive: "2026-10-05", ...filter },
        whole: { startDayKey: "2026-09-28", endDayKeyExclusive: "2026-10-05", ...filter },
        merge: mergeTeamOperations,
      });
      expect(answer.history.totals.scheduled).toBeGreaterThan(0);
      expect(answer.today.totals.scheduled).toBeGreaterThan(0);
    }
  });

  it("sums action actors approximately and recomputes their daily rate", async () => {
    const { t } = await createFixture();
    const answers = await expectMergedAnswer({
      t, identity, live: api.reporting.teamActions.getActionsPerCloserPerDay, ...windows,
      merge: mergeTeamActions,
    });
    expect(answers.history.totalCloserActions).toBeGreaterThan(0);
    expect(answers.today.totalCloserActions).toBeGreaterThan(0);
    // A closer who acts on both sides counts once.
    const both = answers.today.closerActors.filter((actor) =>
      answers.history.closerActors.some((past) => past.userId === actor.userId));
    expect(both.length).toBeGreaterThan(0);
    expect(answers.whole.distinctCloserActors).toBeLessThan(
      answers.history.distinctCloserActors + answers.today.distinctCloserActors,
    );
  });
  it("keeps the available outcome counts when today's payment reclassifies historical calls", async () => {
    const { t, tenantId, payments, meetings } = await createFixture();
    await t.run(async (ctx) => {
      const unpaidMeeting = meetings.find((meeting) => meeting.status === "no_show" && meeting.scheduledAt < windows.today.startDate)!;
      const { _id: _id, _creationTime: _time, ...payment } = payments[0];
      await ctx.db.insert("paymentRecords", { ...payment, tenantId, opportunityId: unpaidMeeting.opportunityId, recordedAt: at("2026-10-04", 6) });
    });
    const reader = t.withIdentity(identity);
    const history = await reader.query(api.reporting.teamOutcomes.getTeamOutcomeMix, windows.history);
    const today = await reader.query(api.reporting.teamOutcomes.getTeamOutcomeMix, windows.today);
    const whole = await reader.query(api.reporting.teamOutcomes.getTeamOutcomeMix, windows.whole);
    const merged = mergeTeamOutcomes(history, today);
    expect(merged.teamOutcome.sold).toBe(history.teamOutcome.sold + today.teamOutcome.sold);
    expect(merged.teamOutcome.sold).toBeLessThan(whole.teamOutcome.sold);
    expect(merged.displayOutcome.sold).toBe(history.displayOutcome.sold + today.displayOutcome.sold);
    expect(merged.derived.rebookRate).toBeCloseTo(merged.derived.rebookNumerator / merged.derived.rebookDenominator);
  });

});
