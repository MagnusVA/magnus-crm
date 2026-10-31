import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  addBusinessDays,
  businessDateForInstant,
  businessDayStart,
  DEFAULT_BUSINESS_DAY,
} from "../../../lib/businessDay";
import { resolveAnalyticsRange, type ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { expectSameAnswer, rowFromDoc } from "../../../tests/analyticsParity";
import { bookingHarness, qualifiedLifecycle } from "../../../tests/bookingHarness";
import { recordBookingAttribution } from "../../lib/attribution/dealAttributions";
import { insertMeetingAggregate } from "../../reporting/writeHooks";
import { buildTeamPerformanceMetrics } from "../../reporting/teamPerformance";

// The fixture's tenant keeps the default business day.
const day = DEFAULT_BUSINESS_DAY;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-04T20:00:00Z");
const identity = { subject: "user_admin", org_id: "org_test" };

afterEach(() => vi.useRealTimers());

const at = (date: string, hours: number) => businessDayStart(date, day) + hours * HOUR;

/**
 * A week of meetings up to today (2026-10-04) across three closers, one of
 * them inactive, with deals at every stage the outcome derivation reads,
 * booking credit for two teams and three DM closer records (D1a and D1b share
 * a team member), payments, a reschedule link, and closer actions.
 */
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
    // Outside the range.
    await meeting(booked, closerA, at("2026-09-27", 12), "held", { credit: { teamId: t1, dmCloserId: d1a } });
    await meeting(paid, closerB, at("2026-10-05", 2), "held");

    const pay = (fields: Partial<Doc<"paymentRecords">>) =>
      ctx.db.insert("paymentRecords", {
        tenantId, amountMinor: 100_000, currency: "USD", recordedByUserId: adminId, programId, programName: "Program",
        paymentType: "pif", status: "verified", recordedAt: at("2026-09-29", 4), origin: "closer_meeting", ...fields,
      });
    await pay({ opportunityId: paid, attributedCloserId: closerA, amountMinor: 250_000 });
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

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function businessRange(startDate: string, endDateInclusive: string) {
  return resolveAnalyticsRange({ kind: "custom", startDate, endDateInclusive }, day, NOW);
}

const inRange = (value: number | undefined, range: ResolvedAnalyticsRange) =>
  value !== undefined && value >= range.fromMs && value < range.toMs;

/** What `meetingCountsSql` returns. */
function meetingCountRows(fixture: Fixture, range: ResolvedAnalyticsRange) {
  const recentFrom = NOW - 2 * DAY;
  const groups = new Map<string, Record<string, unknown>>();
  for (const meeting of fixture.meetings) {
    if (!inRange(meeting.scheduledAt, range)) continue;
    const row = {
      closer_id: meeting.assignedCloserId,
      classification: meeting.callClassification ?? "new",
      meeting_status: meeting.status,
      at_ms: meeting.status === "scheduled" && meeting.scheduledAt >= recentFrom ? meeting.scheduledAt : range.fromMs,
    };
    const key = JSON.stringify(row);
    const group = groups.get(key) ?? { ...row, count: 0 };
    group.count = (group.count as number) + 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** What `paymentsSql` returns: in range, not disputed, in index order. */
function paymentRows(fixture: Fixture, range: ResolvedAnalyticsRange) {
  return fixture.payments
    .filter((payment) => inRange(payment.recordedAt, range) && payment.status !== "disputed")
    .sort((left, right) => left.recordedAt - right.recordedAt || left._creationTime - right._creationTime)
    .map((doc) => rowFromDoc("paymentRecords", doc));
}

/**
 * What `closeRateCohortSql` returns: each deal's first held call by
 * scheduled time then creation time; the deals whose first held call is in
 * the range, counted by that call's closer and booked program.
 */
function closeRateCohortRows(fixture: Fixture, range: ResolvedAnalyticsRange) {
  const deals = new Map(fixture.deals.map((doc) => [doc._id, doc]));
  const firstHeld = new Map<Id<"opportunities">, Doc<"meetings">>();
  for (const meeting of fixture.meetings) {
    if (meeting.status !== "held") continue;
    const first = firstHeld.get(meeting.opportunityId);
    if (
      !first ||
      meeting.scheduledAt < first.scheduledAt ||
      (meeting.scheduledAt === first.scheduledAt && meeting._creationTime < first._creationTime)
    ) {
      firstHeld.set(meeting.opportunityId, meeting);
    }
  }
  const groups = new Map<string, { closer_id: string; booking_program_id: string | null; cohort_deals: number; won_deals: number }>();
  for (const [opportunityId, meeting] of firstHeld) {
    const deal = deals.get(opportunityId);
    if (!deal || !inRange(meeting.scheduledAt, range)) continue;
    const key = JSON.stringify([meeting.assignedCloserId, meeting.bookingProgramId ?? null]);
    const group = groups.get(key) ?? {
      closer_id: meeting.assignedCloserId,
      booking_program_id: meeting.bookingProgramId ?? null,
      cohort_deals: 0,
      won_deals: 0,
    };
    group.cohort_deals += 1;
    if (deal.outcome === "won") group.won_deals += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Every row the `team.metrics` SQL returns for the range. */
function metricsRows(fixture: Fixture, range: ResolvedAnalyticsRange) {
  return {
    meetings: meetingCountRows(fixture, range),
    payments: paymentRows(fixture, range),
    closeRate: closeRateCohortRows(fixture, range),
  };
}

type OperationsFilters = {
  bookingProgramId?: Id<"tenantPrograms">;
  attributionTeamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
};

/** What `meetingBucketsSql` returns for the filters. */
function meetingBucketRows(fixture: Fixture, range: ResolvedAnalyticsRange, filters: OperationsFilters) {
  const recentFrom = addBusinessDays(businessDateForInstant(NOW, day), -2);
  const credited = (role: "dm_team" | "dm_closer", keep: (row: Doc<"dealAttributions">) => boolean) =>
    new Set(
      fixture.attributions
        .filter((row) => row.role === role && row.meetingId && inRange(row.meetingScheduledAt, range) && keep(row))
        .map((row) => row.meetingId),
    );
  const teamCredit = filters.attributionTeamId
    ? credited("dm_team", (row) => row.teamId === filters.attributionTeamId)
    : null;
  const teamMemberId = fixture.dmClosers.find((row) => row._id === filters.dmCloserId)?.teamMemberId;
  const dmCredit = filters.dmCloserId
    ? credited("dm_closer", (row) =>
        teamMemberId !== undefined &&
        row.teamMemberId === teamMemberId &&
        row.source.kind === "booking_utm" &&
        row.source.dmCloserId === filters.dmCloserId)
    : null;
  const perMeeting = teamCredit !== null || dmCredit !== null;
  const deals = new Map(fixture.deals.map((doc) => [doc._id, doc]));
  const groups = new Map<string, Record<string, unknown>>();
  for (const meeting of [...fixture.meetings].sort((left, right) => left.scheduledAt - right.scheduledAt)) {
    const deal = deals.get(meeting.opportunityId);
    if (!deal || !inRange(meeting.scheduledAt, range)) continue;
    if (teamCredit && !teamCredit.has(meeting._id)) continue;
    if (dmCredit && !dmCredit.has(meeting._id)) continue;
    const date = businessDateForInstant(meeting.scheduledAt, day);
    const row = {
      day_key: date < recentFrom ? range.startDate : date,
      meeting_id: perMeeting && date >= recentFrom ? meeting._id : null,
      assigned_closer_id: meeting.assignedCloserId,
      booking_program_id: meeting.bookingProgramId ?? null,
      sold_program_id: deal.soldProgramId ?? null,
      meeting_status: meeting.status,
    };
    const key = JSON.stringify(row);
    const group = groups.get(key) ?? { ...row, count: 0 };
    group.count = (group.count as number) + 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** What `meetingOutcomesSql` returns. */
function meetingOutcomeRows(fixture: Fixture, range: ResolvedAnalyticsRange) {
  const deals = new Map(fixture.deals.map((doc) => [doc._id, doc]));
  const paid = new Set(
    fixture.payments
      .filter((payment) => inRange(payment.recordedAt, range) && payment.status !== "disputed")
      .map((payment) => payment.opportunityId),
  );
  const rescheduled = new Set(
    fixture.meetings
      .filter((meeting) => inRange(meeting.scheduledAt, range))
      .map((meeting) => meeting.rescheduledFromMeetingId),
  );
  const linked = new Set(
    fixture.followUps
      .filter((row) => row.status === "pending" && row.reason === "no_show_follow_up" && row.type === "scheduling_link")
      .map((row) => row.opportunityId),
  );
  const groups = new Map<string, Record<string, unknown>>();
  for (const meeting of fixture.meetings) {
    const deal = deals.get(meeting.opportunityId);
    if (!deal || !inRange(meeting.scheduledAt, range)) continue;
    const endsAt = meeting.scheduledAt + meeting.durationMinutes * 60_000;
    const row = {
      closer_id: meeting.assignedCloserId,
      meeting_status: meeting.status,
      ends_at_ms: meeting.status === "scheduled" && endsAt > NOW ? endsAt : 0,
      deal_source: deal.source ?? null,
      deal_stage: deal.stage,
      deal_outcome: deal.outcome,
      lost_reason: deal.lostReason ?? null,
      lost_by_person: deal.lostByUserId !== undefined ? 1 : 0,
      is_latest_meeting: deal.latestMeetingId === meeting._id ? 1 : 0,
      has_payment: paid.has(meeting.opportunityId) ? 1 : 0,
      is_rescheduled: rescheduled.has(meeting._id) ? 1 : 0,
      has_reschedule_link: linked.has(meeting.opportunityId) ? 1 : 0,
    };
    const key = JSON.stringify(row);
    const group = groups.get(key) ?? { ...row, count: 0 };
    group.count = (group.count as number) + 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** What `closerActionsSql` returns: actors in order of their first action. */
function closerActionRows(fixture: Fixture, range: ResolvedAnalyticsRange) {
  const byActor = new Map<string, { actor_user_id: string; actions: number }>();
  for (const event of [...fixture.events].sort(
    (left, right) => left.occurredAt - right.occurredAt || left._creationTime - right._creationTime,
  )) {
    if (event.source !== "closer" || !event.actorUserId || !inRange(event.occurredAt, range)) continue;
    const row = byActor.get(event.actorUserId) ?? { actor_user_id: event.actorUserId, actions: 0 };
    row.actions += 1;
    byActor.set(event.actorUserId, row);
  }
  return [...byActor.values()];
}

describe("Team Performance from ClickHouse rows", () => {
  it("matches the metrics, outcome mix and actions readers up to today", async () => {
    const fixture = await createFixture();
    const range = businessRange("2026-09-28", "2026-10-04");
    const base = { t: fixture.t, identity, tenantId: fixture.tenantId, range, filters: {} };
    const window = { startDate: range.fromMs, endDate: range.toMs };

    const metrics = await expectSameAnswer({
      ...base,
      reportId: "team.metrics",
      live: api.reporting.teamPerformance.getTeamPerformanceMetrics,
      liveArgs: window,
      rows: metricsRows(fixture, range),
    });
    expect(metrics.teamTotals).toMatchObject({
      newBookedCalls: 9,
      followUpBookedCalls: 3,
      newPastCalls: 7,
      followUpPastCalls: 3,
      totalSales: 2,
      // Paid, lost by a person, and the two follow-ups; the booked deal's
      // first held call was before the range, and payments play no part.
      cohortDeals: 4,
      wonDeals: 0,
      overallCloseRate: 0,
    });

    const outcomes = await expectSameAnswer({
      ...base,
      reportId: "team.outcomes",
      live: api.reporting.teamOutcomes.getTeamOutcomeMix,
      liveArgs: window,
      rows: { outcomes: meetingOutcomeRows(fixture, range) },
    });
    expect(outcomes.teamOutcome).toMatchObject({
      sold: 1, lost: 1, no_show: 2, canceled: 1, rescheduled: 1, follow_up: 1, scheduled: 6,
    });
    expect(outcomes.displayOutcome).toMatchObject({ not_recorded: 2, upcoming: 1 });

    const actions = await expectSameAnswer({
      ...base,
      reportId: "team.actions",
      live: api.reporting.teamActions.getActionsPerCloserPerDay,
      liveArgs: window,
      rows: { actions: closerActionRows(fixture, range) },
    });
    expect(actions.topCloserActors.map((actor: { actorName: string; count: number }) => [actor.actorName, actor.count])).toEqual([
      ["Closer B", 2], ["Closer A", 2], ["Former", 1],
    ]);
  });

  it("counts each deal once in the close rate, at its first held call, whatever was paid", async () => {
    const base = await createFixture();
    const { t, tenantId } = base;
    await t.run(async (ctx) => {
      const user = async (workosUserId: string) =>
        (await ctx.db.query("users").withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId)).unique())!._id;
      const adminId = await user("user_admin");
      const closerA = await user("user_closer");
      const closerB = await user("user_Closer B");
      const leadId = base.deals[0].leadId;
      const deal = (fields: Partial<Doc<"opportunities">>) =>
        ctx.db.insert("opportunities", {
          tenantId, leadId, stage: "closed", outcome: "won", source: "calendly",
          assignedCloserId: closerA, createdAt: 0, updatedAt: 0, ...fields,
        });
      let index = 100;
      const meeting = async (
        opportunityId: Id<"opportunities">,
        assignedCloserId: Id<"users">,
        scheduledAt: number,
        status: Doc<"meetings">["status"],
      ) => {
        index += 1;
        const meetingId = await ctx.db.insert("meetings", {
          tenantId, opportunityId, assignedCloserId,
          calendlyEventUri: `https://api.calendly.com/scheduled_events/m${index}`,
          calendlyInviteeUri: `https://api.calendly.com/scheduled_events/m${index}/invitees/person`,
          scheduledAt, durationMinutes: 30, status, callClassification: "new", createdAt: scheduledAt - DAY,
          ...(status === "held" ? { heldMarkedAt: scheduledAt } : {}),
        });
        await insertMeetingAggregate(ctx, meetingId);
      };
      // Won, two held calls in the range: counted once, for A's first call.
      const twoHeld = await deal({});
      await meeting(twoHeld, closerA, at("2026-09-29", 14), "held");
      await meeting(twoHeld, closerB, at("2026-10-01", 14), "held");
      // Won, now assigned to B, but A held its first call: A's.
      const reassigned = await deal({ assignedCloserId: closerB });
      await meeting(reassigned, closerA, at("2026-09-30", 14), "held");
      // Won and paid in the range with no held call: out of the cohort.
      const paidNoHeld = await deal({});
      await meeting(paidNoHeld, closerA, at("2026-10-02", 14), "no_show");
      await ctx.db.insert("paymentRecords", {
        tenantId, opportunityId: paidNoHeld, attributedCloserId: closerA, amountMinor: 50_000, currency: "USD",
        recordedByUserId: adminId, programId: base.programs[0]._id, programName: "Program", paymentType: "pif", status: "verified",
        recordedAt: at("2026-10-02", 15), origin: "closer_meeting",
      });
      // Open, two held calls at the same time: the first created, B's, counts.
      const tied = await deal({ stage: "call_held", outcome: "open" });
      await meeting(tied, closerB, at("2026-10-03", 14), "held");
      await meeting(tied, closerA, at("2026-10-03", 14), "held");
    });
    const fixture = {
      ...base,
      meetings: await t.run(async (ctx) => await ctx.db.query("meetings").take(100)),
      deals: await t.run(async (ctx) => await ctx.db.query("opportunities").take(100)),
      payments: await t.run(async (ctx) => await ctx.db.query("paymentRecords").take(100)),
    };
    const range = businessRange("2026-09-28", "2026-10-04");
    const metrics = await expectSameAnswer({
      t, identity, tenantId, range, filters: {},
      reportId: "team.metrics",
      live: api.reporting.teamPerformance.getTeamPerformanceMetrics,
      liveArgs: { startDate: range.fromMs, endDate: range.toMs },
      rows: metricsRows(fixture, range),
    });
    const closer = (name: string) =>
      metrics.closers.find((row: { closerName: string }) => row.closerName === name);
    // A: paid, lost by a person, the follow-up with a link, two held, reassigned.
    expect(closer("Closer A")).toMatchObject({ cohortDeals: 5, wonDeals: 2, closeRate: 0.4 });
    // B: the follow-up without a link, and the tie.
    expect(closer("Closer B")).toMatchObject({ cohortDeals: 2, wonDeals: 0, closeRate: 0 });
    expect(metrics.teamTotals).toMatchObject({ cohortDeals: 7, wonDeals: 2, overallCloseRate: 2 / 7 });
    expect(metrics.isCloseRateCohortTruncated).toBe(false);
  });

  it("leaves the close rate unknown when the cohort read is capped", async () => {
    const { t, tenantId } = await createFixture();
    const range = businessRange("2026-09-28", "2026-10-04");
    const answer = await t.run(async (ctx) => {
      const closerId = (await ctx.db.query("users").withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer")).unique())!._id;
      return await buildTeamPerformanceMetrics(ctx, tenantId, { startDate: range.fromMs, endDate: range.toMs }, {
        countMeetings: async (keys) => keys.map(() => 0),
        paymentScan: { payments: [], isTruncated: false },
        closeRateCohort: { counts: [{ closerId, bookingProgramId: null, cohortDeals: 3, wonDeals: 1 }], capped: true },
      });
    });
    expect(answer.isCloseRateCohortTruncated).toBe(true);
    expect(answer.teamTotals).toMatchObject({ overallCloseRate: null, cohortDeals: null, wonDeals: null });
    for (const closer of answer.closers) {
      expect(closer).toMatchObject({ closeRate: null, cohortDeals: null, wonDeals: null });
    }
  });

  it("matches the metrics and outcome mix readers for a past range, every day folded", async () => {
    const fixture = await createFixture();
    const range = businessRange("2026-09-28", "2026-09-30");
    const base = { t: fixture.t, identity, tenantId: fixture.tenantId, range, filters: {} };
    const window = { startDate: range.fromMs, endDate: range.toMs };
    await expectSameAnswer({
      ...base,
      reportId: "team.metrics",
      live: api.reporting.teamPerformance.getTeamPerformanceMetrics,
      liveArgs: window,
      rows: metricsRows(fixture, range),
    });
    await expectSameAnswer({
      ...base,
      reportId: "team.outcomes",
      live: api.reporting.teamOutcomes.getTeamOutcomeMix,
      liveArgs: window,
      rows: { outcomes: meetingOutcomeRows(fixture, range) },
    });
  });

  it("matches the operations reader for every program, team and DM closer filter", async () => {
    const fixture = await createFixture();
    const range = businessRange("2026-09-28", "2026-10-04");
    const programId = fixture.programs[0]._id;
    const [t1, t2] = fixture.teams.map((team) => team._id);
    const [d1a, d1b, d2] = fixture.dmClosers.map((row) => row._id);
    const cases: Array<[OperationsFilters, number]> = [
      [{}, 13],
      [{ bookingProgramId: programId }, 4],
      [{ attributionTeamId: t1 }, 7],
      [{ dmCloserId: d1a }, 6],
      [{ dmCloserId: d1b }, 1],
      [{ attributionTeamId: t2, dmCloserId: d2 }, 2],
      [{ attributionTeamId: t2, dmCloserId: d1a }, 0],
      [{ attributionTeamId: t1, bookingProgramId: programId }, 3],
    ];
    for (const [filters, scheduled] of cases) {
      const live = await expectSameAnswer({
        t: fixture.t,
        identity,
        tenantId: fixture.tenantId,
        range,
        reportId: "team.operations",
        live: api.reporting.teamPerformance.getTeamOperationsDimensions,
        liveArgs: { startDayKey: "2026-09-28", endDayKeyExclusive: "2026-10-05", ...filters },
        filters,
        rows: { buckets: meetingBucketRows(fixture, range, filters) },
      });
      expect(live.totals.scheduled).toBe(scheduled);
      if (filters.dmCloserId === d2) expect(live.totals.notRecorded).toBe(1);
    }
  });
});
