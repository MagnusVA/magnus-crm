import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import {
  addBusinessDays,
  businessDateForInstant,
  businessDayStart,
  DEFAULT_BUSINESS_DAY,
} from "../../../lib/businessDay";
import { resolveAnalyticsRange } from "../../../lib/analyticsRange";
import { expectSameAnswer, rowFromDoc } from "../../../tests/analyticsParity";
import {
  BOOKED_CALLS_ADMIN,
  seedBookedCallsFixture,
} from "../../../tests/bookedCallsFixture";
import { qualifiedLifecycle } from "../../../tests/bookingHarness";

// The fixtures' tenants keep the default business day.
const day = DEFAULT_BUSINESS_DAY;
const HOUR = 60 * 60 * 1000;
const identity = { subject: "admin_a", org_id: "org_a" };

function dashboardRange(startBusinessDate: string, endBusinessDateInclusive: string) {
  return {
    range: resolveAnalyticsRange(
      { kind: "custom", startDate: startBusinessDate, endDateInclusive: endBusinessDateInclusive },
      day,
      Date.now(),
    ),
    liveArgs: { range: { kind: "custom", startBusinessDate, endBusinessDateInclusive } },
  };
}

function compareKeys(left: readonly (string | null)[], right: readonly (string | null)[]) {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    // ClickHouse sorts NULL last.
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : 1;
  }
  return 0;
}

async function insertTenant(
  ctx: MutationCtx,
  fields: Partial<Doc<"tenants">> = {},
) {
  return await ctx.db.insert("tenants", {
    businessDayAppliedVersion: 0,
    companyName: "Tenant",
    contactEmail: "tenant@example.invalid",
    workosOrgId: identity.org_id,
    status: "active",
    inviteExpiresAt: Date.now() + 24 * HOUR,
    createdBy: "test",
    ...fields,
  });
}

// ---------------------------------------------------------------------------
// Sales Calls
// ---------------------------------------------------------------------------

/**
 * What `meetingBucketsSql` returns: the meetings' buckets, days before
 * `recent_from` folded into the range's first day.
 */
function meetingBucketRows(
  meetings: Doc<"meetings">[],
  deals: Map<Id<"opportunities">, Doc<"opportunities">>,
  range: { startDate: string; fromMs: number; toMs: number },
) {
  const recentFrom = addBusinessDays(businessDateForInstant(Date.now(), day), -2);
  const buckets = new Map<string, { key: (string | null)[]; count: number }>();
  for (const meeting of meetings) {
    const deal = deals.get(meeting.opportunityId);
    if (!deal || meeting.scheduledAt < range.fromMs || meeting.scheduledAt >= range.toMs) continue;
    const date = businessDateForInstant(meeting.scheduledAt, day);
    const key = [
      date < recentFrom ? range.startDate : date,
      meeting.assignedCloserId,
      meeting.bookingProgramId ?? null,
      deal.soldProgramId ?? null,
      meeting.status,
    ];
    const bucket = buckets.get(JSON.stringify(key)) ?? { key, count: 0 };
    bucket.count += 1;
    buckets.set(JSON.stringify(key), bucket);
  }
  return [...buckets.values()]
    .sort((left, right) => compareKeys(left.key, right.key))
    .map(({ key, count }) => ({
      day_key: key[0],
      assigned_closer_id: key[1],
      booking_program_id: key[2],
      sold_program_id: key[3],
      meeting_status: key[4],
      count,
    }));
}

/**
 * What `closeRateCohortSql` returns: each deal's first held call (by
 * scheduled time, then creation time), kept when it is in the range and the
 * deal exists, counted by that call's closer and booked program.
 */
function closeRateCohortRows(
  meetings: Doc<"meetings">[],
  deals: Map<Id<"opportunities">, Doc<"opportunities">>,
  range: { fromMs: number; toMs: number },
) {
  const firstHeld = new Map<Id<"opportunities">, Doc<"meetings">>();
  for (const meeting of meetings) {
    if (meeting.status !== "held") continue;
    const current = firstHeld.get(meeting.opportunityId);
    if (
      !current ||
      meeting.scheduledAt < current.scheduledAt ||
      (meeting.scheduledAt === current.scheduledAt && meeting._creationTime < current._creationTime)
    ) {
      firstHeld.set(meeting.opportunityId, meeting);
    }
  }
  const groups = new Map<string, { key: (string | null)[]; cohort: number; won: number }>();
  for (const meeting of firstHeld.values()) {
    const deal = deals.get(meeting.opportunityId);
    if (!deal || meeting.scheduledAt < range.fromMs || meeting.scheduledAt >= range.toMs) continue;
    const key = [meeting.assignedCloserId, meeting.bookingProgramId ?? null];
    const group = groups.get(JSON.stringify(key)) ?? { key, cohort: 0, won: 0 };
    group.cohort += 1;
    if (deal.outcome === "won") group.won += 1;
    groups.set(JSON.stringify(key), group);
  }
  return [...groups.values()]
    .sort((left, right) => compareKeys(left.key, right.key))
    .map(({ key, cohort, won }) => ({
      closer_id: key[0],
      booking_program_id: key[1],
      cohort_deals: cohort,
      won_deals: won,
    }));
}

/**
 * Meetings over `days`, their deals and payments, and the buckets the
 * projection would hold for them, inserted in index order.
 */
async function createSalesCallsFixture(days: string[]) {
  const t = convexTest({ schema, modules: convexTestModules });
  const at = (dayIndex: number, hour: number) => businessDayStart(days[dayIndex], day) + hour * HOUR;
  const fixture = await t.run(async (ctx) => {
    const tenantId = await insertTenant(ctx, { meetingProjectionVersion: 2 });
    const user = (workosUserId: string, role: Doc<"users">["role"], fullName: string, isActive = true) =>
      ctx.db.insert("users", { tenantId, workosUserId, email: `${workosUserId}@example.invalid`, role, fullName, isActive });
    const adminId = await user("admin_a", "tenant_admin", "Ana Admin");
    const carla = await user("closer_1", "closer", "Carla Closer");
    const beto = await user("closer_2", "closer", "Beto Closer");
    // Inactive: shows only through the meetings it holds.
    const olga = await user("closer_3", "closer", "Olga Former", false);
    await user("closer_4", "closer", "Zed Idle");
    const program = (name: string) =>
      ctx.db.insert("tenantPrograms", {
        tenantId,
        name,
        normalizedName: name.toLowerCase(),
        createdAt: at(0, 0),
        updatedAt: at(0, 0),
        createdByUserId: adminId,
      });
    const mentorship = await program("Mentorship");
    const coaching = await program("Coaching");
    const deal = async (
      closerId: Id<"users">,
      soldProgramId?: Id<"tenantPrograms">,
      outcome: Doc<"opportunities">["outcome"] = soldProgramId ? "won" : "open",
      dealTenantId: Id<"tenants"> = tenantId,
    ) => {
      const leadId = await ctx.db.insert("leads", {
        ...qualifiedLifecycle(at(0, 0)),
        tenantId: dealTenantId,
        fullName: "Lead",
        firstSeenAt: at(0, 0),
        updatedAt: at(0, 0),
        status: "active",
      });
      return await ctx.db.insert("opportunities", {
        tenantId: dealTenantId,
        leadId,
        stage: outcome === "open" ? "booked" : "closed",
        outcome,
        assignedCloserId: closerId,
        ...(soldProgramId ? { soldProgramId, soldProgramName: "Mentorship" } : {}),
        createdAt: at(0, 0),
        updatedAt: at(0, 0),
      });
    };
    const sold = await deal(carla, mentorship);
    const open = await deal(beto);
    const former = await deal(olga);
    // Close rate cases: two held calls in the range on a deal since
    // reassigned to Beto (credited once, to Carla's first call), a lost deal,
    // and a deal whose calls were never held.
    const twice = await deal(beto, mentorship);
    const lost = await deal(beto, undefined, "lost");
    const ghost = await deal(carla, undefined, "lost");
    let meetingIndex = 0;
    const meeting = (
      opportunityId: Id<"opportunities">,
      assignedCloserId: Id<"users">,
      scheduledAt: number,
      status: Doc<"meetings">["status"],
      bookingProgramId?: Id<"tenantPrograms">,
      meetingTenantId: Id<"tenants"> = tenantId,
    ) => {
      meetingIndex += 1;
      return ctx.db.insert("meetings", {
        tenantId: meetingTenantId,
        opportunityId,
        assignedCloserId,
        calendlyEventUri: `https://example.invalid/event/${meetingIndex}`,
        calendlyInviteeUri: `https://example.invalid/invitee/${meetingIndex}`,
        scheduledAt,
        durationMinutes: 30,
        status,
        createdAt: scheduledAt - 24 * HOUR,
        ...(bookingProgramId ? { bookingProgramId, bookingProgramName: "Program" } : {}),
      });
    };
    const last = days.length - 1;
    await meeting(sold, carla, at(0, 10), "held", mentorship);
    await meeting(sold, carla, at(0, 12), "held", mentorship);
    await meeting(open, beto, at(0, 11), "no_show", coaching);
    await meeting(open, beto, at(1, 9), "canceled");
    await meeting(open, beto, at(1, 15), "scheduled", coaching);
    await meeting(former, olga, at(1, 16), "held");
    await meeting(sold, carla, at(last, 13), "scheduled", mentorship);
    await meeting(open, beto, at(last, 14), "held", coaching);
    await meeting(twice, carla, at(0, 9), "held", mentorship);
    await meeting(twice, beto, at(1, 10), "held", coaching);
    await meeting(lost, beto, at(1, 12), "held");
    await meeting(ghost, carla, at(0, 15), "canceled", mentorship);
    await meeting(ghost, carla, at(1, 13), "no_show", mentorship);
    // Outside the range. The sold deal's first held call is here, so the
    // deal stays out of the close rate though it has held calls in the range.
    await meeting(sold, carla, at(0, 0) - 2 * HOUR, "held", mentorship);
    await meeting(open, beto, businessDayStart(addBusinessDays(days[last], 1), day) + HOUR, "held");
    // Another tenant's won deal, held in the range.
    const otherTenantId = await insertTenant(ctx, { workosOrgId: "org_other" });
    const outsider = await ctx.db.insert("users", {
      tenantId: otherTenantId, workosUserId: "closer_other", email: "closer_other@example.invalid",
      role: "closer", fullName: "Other Tenant", isActive: true,
    });
    const foreign = await deal(outsider, undefined, "won", otherTenantId);
    await meeting(foreign, outsider, at(0, 10), "held", undefined, otherTenantId);

    const pay = (fields: Partial<Doc<"paymentRecords">>) =>
      ctx.db.insert("paymentRecords", {
        tenantId,
        amountMinor: 100_000,
        currency: "USD",
        recordedByUserId: adminId,
        programId: mentorship,
        programName: "Mentorship",
        paymentType: "pif",
        status: "verified",
        recordedAt: at(0, 14),
        origin: "closer_meeting",
        ...fields,
      });
    await pay({ attributedCloserId: carla, amountMinor: 250_000 });
    await pay({ attributedCloserId: carla, currency: "gbp", amountMinor: 80_000, recordedAt: at(1, 10) });
    await pay({ attributedCloserId: beto, paymentType: "deposit", amountMinor: 50_000 });
    await pay({ attributedCloserId: olga, programId: coaching, programName: "Coaching", paymentType: "split", recordedAt: at(last, 9) });
    // No closer: counts on the cards, not in the team total.
    await pay({ programId: coaching, programName: "Coaching", amountMinor: 30_000, recordedAt: at(1, 11) });
    await pay({ attributedCloserId: carla, status: "disputed" });
    await pay({ attributedCloserId: carla, recordedAt: at(0, 0) - HOUR });

    // This tenant's documents, as the views return them for its tenant_id.
    const meetings = (await ctx.db.query("meetings").take(100)).filter((doc) => doc.tenantId === tenantId);
    const deals = new Map(
      (await ctx.db.query("opportunities").take(100))
        .filter((doc) => doc.tenantId === tenantId)
        .map((doc) => [doc._id, doc]),
    );
    // The buckets the projection keeps, in by_tenantId_and_dayKey order.
    const buckets = new Map<string, { dayKey: string; meeting: Doc<"meetings">; count: number }>();
    for (const doc of [...meetings].sort((left, right) => left.scheduledAt - right.scheduledAt)) {
      const dayKey = businessDateForInstant(doc.scheduledAt, day);
      const key = JSON.stringify([dayKey, doc.assignedCloserId, doc.bookingProgramId ?? null, deals.get(doc.opportunityId)?.soldProgramId ?? null, doc.status]);
      const bucket = buckets.get(key) ?? { dayKey, meeting: doc, count: 0 };
      bucket.count += 1;
      buckets.set(key, bucket);
    }
    for (const [bucketKey, bucket] of buckets) {
      await ctx.db.insert("operationsMeetingStatsV2", {
        tenantId,
        dayKey: bucket.dayKey,
        assignedCloserId: bucket.meeting.assignedCloserId,
        bookingProgramId: bucket.meeting.bookingProgramId,
        soldProgramId: deals.get(bucket.meeting.opportunityId)?.soldProgramId,
        meetingStatus: bucket.meeting.status,
        bucketKey,
        count: bucket.count,
        updatedAt: at(0, 0),
      });
    }
    const payments = (await ctx.db.query("paymentRecords").take(100)).sort(
      (left, right) => left.recordedAt - right.recordedAt || left._creationTime - right._creationTime,
    );
    return { tenantId, meetings, deals: [...deals.values()], payments };
  });
  return { t, ...fixture, deals: new Map(fixture.deals.map((doc) => [doc._id, doc])) };
}

async function expectSalesCallsParity(
  startBusinessDate: string,
  endBusinessDateInclusive: string,
  days: string[],
): Promise<FunctionReturnType<typeof api.operations.salesCallsDashboard.getSalesCallsDashboard>> {
  const fixture = await createSalesCallsFixture(days);
  const { range, liveArgs } = dashboardRange(startBusinessDate, endBusinessDateInclusive);
  // What paymentsSql selects: in range, not disputed, in index order.
  const payments = fixture.payments.filter(
    (payment) => payment.recordedAt >= range.fromMs && payment.recordedAt < range.toMs && payment.status !== "disputed",
  );
  return await expectSameAnswer({
    t: fixture.t,
    identity,
    tenantId: fixture.tenantId,
    range,
    reportId: "sales_calls.dashboard",
    live: api.operations.salesCallsDashboard.getSalesCallsDashboard,
    liveArgs,
    filters: {},
    rows: {
      buckets: meetingBucketRows(fixture.meetings, fixture.deals, range),
      payments: payments.map((doc) => rowFromDoc("paymentRecords", doc)),
      closeRateCohort: closeRateCohortRows(fixture.meetings, fixture.deals, range),
    },
  });
}

/**
 * The close rate cohort in both ranges: the reassigned deal won at Carla's
 * first call, an open deal and a lost one for Beto, Olga's open deal. The
 * sold deal (first held call before the range), the never-held deal and the
 * other tenant's deal stay out.
 */
function expectCloseRates(live: FunctionReturnType<typeof api.operations.salesCallsDashboard.getSalesCallsDashboard>) {
  expect(live.stats).toMatchObject({ closeRate: 0.25, cohortDeals: 4, wonDeals: 1 });
  expect(live.teamTotal).toMatchObject({ closeRate: 0.25, cohortDeals: 4, wonDeals: 1 });
  const closer = (label: string) => live.closers.find((row) => row.label === label);
  expect(closer("Carla Closer")).toMatchObject({ closeRate: 1, cohortDeals: 1, wonDeals: 1 });
  expect(closer("Beto Closer")).toMatchObject({ closeRate: 0, cohortDeals: 2, wonDeals: 0 });
  expect(closer("Olga Former")).toMatchObject({ closeRate: 0, cohortDeals: 1, wonDeals: 0 });
  expect(closer("Zed Idle")).toMatchObject({ closeRate: null, cohortDeals: 0, wonDeals: 0 });
  const program = (label: string) => live.perProgram.find((row) => row.label === label);
  expect(program("Mentorship")).toMatchObject({ closeRate: 1, cohortDeals: 1, wonDeals: 1 });
  expect(program("Coaching")).toMatchObject({ closeRate: 0, cohortDeals: 1, wonDeals: 0 });
  expect(program("No program")).toMatchObject({ closeRate: 0, cohortDeals: 2, wonDeals: 0 });
}

describe("Sales Calls from ClickHouse rows", () => {
  it("matches the Convex reader for a past range, every day folded", async () => {
    const days = ["2026-09-14", "2026-09-15", "2026-09-16"];
    const live = await expectSalesCallsParity("2026-09-14", "2026-09-16", days);
    expect(live).toMatchObject({
      capped: false,
      stats: { totalCalls: 13, showed: 7, canceled: 2, noShows: 2, pastCalls: 11 },
    });
    expect(live.stats.moneyByCurrency.map((bucket) => bucket.currency)).toEqual(["GBP", "USD"]);
    expect(live.closers.map((closer) => closer.label)).toEqual([
      "Beto Closer", "Carla Closer", "Olga Former", "Zed Idle",
    ]);
    expectCloseRates(live);
  });

  it("matches the Convex reader up to today, the last days kept", async () => {
    const today = businessDateForInstant(Date.now(), day);
    const days = [-4, -3, -2, -1, 0].map((offset) => addBusinessDays(today, offset));
    const live = await expectSalesCallsParity(days[0], today, days);
    expect(live).toMatchObject({ capped: false, stats: { totalCalls: 13 } });
    expectCloseRates(live);
  });
});

// ---------------------------------------------------------------------------
// Booked Calls
// ---------------------------------------------------------------------------

/** What `bookingCreditCountsSql` returns for the fixture's documents. */
function bookingCreditRows(
  meetings: Doc<"meetings">[],
  attributions: Doc<"dealAttributions">[],
  range: { fromMs: number; toMs: number },
) {
  const latest = new Map<string, Doc<"dealAttributions">>();
  for (const row of attributions) {
    if (
      !row.meetingId ||
      (row.role !== "dm_team" && row.role !== "dm_closer") ||
      row.source.kind !== "booking_utm" ||
      row.attributedAt < range.fromMs ||
      row.attributedAt >= range.toMs ||
      (row.role === "dm_team" && !row.teamId)
    ) {
      continue;
    }
    const key = `${row.meetingId}:${row.role}`;
    const current = latest.get(key);
    if (
      !current ||
      row.attributedAt > current.attributedAt ||
      (row.attributedAt === current.attributedAt && row._creationTime > current._creationTime)
    ) {
      latest.set(key, row);
    }
  }
  const groups = new Map<string, { key: (string | null)[]; booked: number }>();
  for (const meeting of meetings) {
    if (meeting.createdAt < range.fromMs || meeting.createdAt >= range.toMs) continue;
    if (meeting.callClassification === "follow_up") continue;
    const team = latest.get(`${meeting._id}:dm_team`);
    const closer = latest.get(`${meeting._id}:dm_closer`);
    if (!team && !closer) continue;
    const key = [
      team?.teamId ?? null,
      closer?.source.kind === "booking_utm" ? (closer.source.dmCloserId ?? null) : null,
    ];
    const group = groups.get(JSON.stringify(key)) ?? { key, booked: 0 };
    group.booked += 1;
    groups.set(JSON.stringify(key), group);
  }
  return [...groups.values()]
    .sort((left, right) => compareKeys(left.key, right.key))
    .map(({ key, booked }) => ({ team_id: key[0], dm_closer_id: key[1], booked }));
}

async function expectBookedCallsParity(startBusinessDate: string, endBusinessDateInclusive: string) {
  const t = convexTest({ schema, modules: convexTestModules });
  const fixture = await t.run(async (ctx) => {
    const seeded = await seedBookedCallsFixture(ctx);
    return {
      tenantId: seeded.tenantId,
      meetings: await ctx.db.query("meetings").take(100),
      attributions: await ctx.db.query("dealAttributions").take(200),
    };
  });
  const { range, liveArgs } = dashboardRange(startBusinessDate, endBusinessDateInclusive);
  return await expectSameAnswer({
    t,
    identity: BOOKED_CALLS_ADMIN,
    tenantId: fixture.tenantId,
    range,
    reportId: "booked_calls.dashboard",
    live: api.operations.bookedCallsDashboard.getBookedCallsDashboard,
    liveArgs,
    filters: {},
    rows: { bookings: bookingCreditRows(fixture.meetings, fixture.attributions, range) },
  });
}

describe("Booked Calls from ClickHouse rows", () => {
  it("matches the Convex reader on one business day", async () => {
    const live = await expectBookedCallsParity("2026-08-14", "2026-08-14");
    expect(live).toMatchObject({ capped: false, totalBooked: 3, goal: { progress: 4 } });
  });

  it("matches the Convex reader on a two-day range, the earlier booking included", async () => {
    const live = await expectBookedCallsParity("2026-08-13", "2026-08-14");
    expect(live).toMatchObject({ capped: false, totalBooked: 4, goal: { businessDayCount: 2 } });
  });
});

// ---------------------------------------------------------------------------
// Qualifications
// ---------------------------------------------------------------------------

/** What `qualifiedBySlackUserSql` returns: openers in order of first event. */
function qualifiedRows(events: Doc<"slackQualificationEvents">[], range: { fromMs: number; toMs: number }) {
  const inRange = events
    .filter((event) => event.submittedAt >= range.fromMs && event.submittedAt < range.toMs)
    .sort((left, right) => left.submittedAt - right.submittedAt || left._creationTime - right._creationTime);
  const byUser = new Map<string, { slack_user_id: string; qualified: number; last_event_at: number }>();
  for (const event of inRange) {
    const row = byUser.get(event.slackUserId) ?? { slack_user_id: event.slackUserId, qualified: 0, last_event_at: 0 };
    row.qualified += 1;
    row.last_event_at = Math.max(row.last_event_at, event.submittedAt);
    byUser.set(event.slackUserId, row);
  }
  return [...byUser.values()];
}

async function expectQualificationsParity(
  startBusinessDate: string,
  endBusinessDateInclusive: string,
): Promise<FunctionReturnType<typeof api.operations.qualificationsDashboard.getQualificationsDashboard>> {
  const t = convexTest({ schema, modules: convexTestModules });
  const start = businessDayStart("2026-09-14", day);
  const fixture = await t.run(async (ctx) => {
    const tenantId = await insertTenant(ctx, { slackQualificationDailyTeamQuota: 5 });
    const adminId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: identity.subject,
      email: "admin@example.invalid",
      role: "tenant_admin",
      isActive: true,
    });
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
      botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
      installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
    });
    const slackUser = (slackUserId: string, names: Partial<Doc<"slackUsers">>) =>
      ctx.db.insert("slackUsers", {
        tenantId, installationId, slackUserId, slackTeamId: "T1",
        isBot: false, isDeleted: false, firstSeenAt: 0, lastSeenAt: 0, lastSyncedAt: 0,
        ...names,
      });
    await slackUser("U1", { displayName: "Sam Setter" });
    await slackUser("U2", { realName: "Rita Real" });
    await slackUser("U4", { username: "scheduled.only" });
    // U1 and U4 have schedules; U4 logs nothing and still shows at zero.
    for (const [slackUserId, weekday, scheduledHours] of [
      ["U1", "monday", 4],
      ["U1", "tuesday", 2],
      ["U4", "monday", 3],
    ] as const) {
      await ctx.db.insert("slackQualifierSchedules", {
        tenantId, slackUserId, weekday, scheduledHours, updatedByUserId: adminId, updatedAt: 0,
      });
    }
    const event = (slackUserId: string, submittedAt: number) =>
      ctx.db.insert("slackQualificationEvents", {
        tenantId, installationId,
        resultKind: "unlinked",
        qualifiedBy: { slackUserId, slackTeamId: "T1", submittedAt },
        slackUserId, slackTeamId: "T1", fullNameSnapshot: "Lead",
        platform: "instagram", handleSnapshot: "lead",
        submittedAt, createdAt: submittedAt,
      });
    // U3 has no Slack profile: its label is its id.
    await event("U3", start + 2 * HOUR);
    await event("U2", start + 3 * HOUR);
    await event("U1", start + 3 * HOUR);
    await event("U2", start + 5 * HOUR);
    await event("U1", start + 26 * HOUR);
    await event("U1", start + 27 * HOUR);
    await event("U2", start - HOUR);
    await event("U3", start + 50 * HOUR);
    return { tenantId, events: await ctx.db.query("slackQualificationEvents").take(100) };
  });
  const { range, liveArgs } = dashboardRange(startBusinessDate, endBusinessDateInclusive);
  return await expectSameAnswer({
    t,
    identity,
    tenantId: fixture.tenantId,
    range,
    reportId: "qualifications.dashboard",
    live: api.operations.qualificationsDashboard.getQualificationsDashboard,
    liveArgs,
    filters: {},
    rows: { openers: qualifiedRows(fixture.events, range) },
  });
}

describe("Qualifications from ClickHouse rows", () => {
  it("matches the Convex reader over a week", async () => {
    const live = await expectQualificationsParity("2026-09-14", "2026-09-20");
    expect(live.totalQualified).toBe(7);
    expect(live.openers.map((opener) => [opener.key, opener.qualified])).toEqual([
      ["U1", 3], ["U2", 2], ["U3", 2], ["U4", 0],
    ]);
  });

  it("matches the Convex reader on one day, with schedules and no events", async () => {
    const live = await expectQualificationsParity("2026-09-15", "2026-09-15");
    expect(live.openers.map((opener) => [opener.key, opener.qualified])).toEqual([
      ["U1", 2], ["U4", 0],
    ]);
  });
});
