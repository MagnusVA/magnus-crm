import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { BOOKED_CALLS_ADMIN, seedBookedCallsFixture } from "../../../tests/bookedCallsFixture";
import { qualifiedLifecycle } from "../../../tests/bookingHarness";
import {
  mergeSalesCallsDashboard,
  mergeBookedCallsDashboard,
  mergeQualificationsDashboard,
} from "./operations";

const day = DEFAULT_BUSINESS_DAY;
const HOUR = 60 * 60 * 1000;
const identity = { subject: "admin_a", org_id: "org_a" };
afterEach(() => vi.useRealTimers());

function range(startBusinessDate: string, endBusinessDateInclusive: string) {
  return { range: { kind: "custom" as const, startBusinessDate, endBusinessDateInclusive } };
}

async function insertTenant(ctx: MutationCtx, fields: Partial<Doc<"tenants">> = {}) {
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

async function createSalesCallsFixture(days: string[]) {
  const t = convexTest({ schema, modules: convexTestModules });
  const at = (dayIndex: number, hour: number) =>
    businessDayStart(days[dayIndex], day) + hour * HOUR;
  const fixture = await t.run(async (ctx) => {
    const tenantId = await insertTenant(ctx, { meetingProjectionVersion: 2 });
    const user = (
      workosUserId: string,
      role: Doc<"users">["role"],
      fullName: string,
      isActive = true,
    ) =>
      ctx.db.insert("users", {
        tenantId,
        workosUserId,
        email: `${workosUserId}@example.invalid`,
        role,
        fullName,
        isActive,
      });
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
      tenantId: otherTenantId,
      workosUserId: "closer_other",
      email: "closer_other@example.invalid",
      role: "closer",
      fullName: "Other Tenant",
      isActive: true,
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
    await pay({
      attributedCloserId: carla,
      currency: "gbp",
      amountMinor: 80_000,
      recordedAt: at(1, 10),
    });
    await pay({ attributedCloserId: beto, paymentType: "deposit", amountMinor: 50_000 });
    await pay({
      attributedCloserId: olga,
      programId: coaching,
      programName: "Coaching",
      paymentType: "split",
      recordedAt: at(last, 9),
    });
    // No closer: counts on the cards, not in the team total.
    await pay({
      programId: coaching,
      programName: "Coaching",
      amountMinor: 30_000,
      recordedAt: at(1, 11),
    });
    await pay({ attributedCloserId: carla, status: "disputed" });
    await pay({ attributedCloserId: carla, recordedAt: at(0, 0) - HOUR });

    // This tenant's documents, as the views return them for its tenant_id.
    const meetings = (await ctx.db.query("meetings").take(100)).filter(
      (doc) => doc.tenantId === tenantId,
    );
    const deals = new Map(
      (await ctx.db.query("opportunities").take(100))
        .filter((doc) => doc.tenantId === tenantId)
        .map((doc) => [doc._id, doc]),
    );
    // The buckets the projection keeps, in by_tenantId_and_dayKey order.
    const buckets = new Map<string, { dayKey: string; meeting: Doc<"meetings">; count: number }>();
    for (const doc of [...meetings].sort((left, right) => left.scheduledAt - right.scheduledAt)) {
      const dayKey = businessDateForInstant(doc.scheduledAt, day);
      const key = JSON.stringify([
        dayKey,
        doc.assignedCloserId,
        doc.bookingProgramId ?? null,
        deals.get(doc.opportunityId)?.soldProgramId ?? null,
        doc.status,
      ]);
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
      (left, right) =>
        left.recordedAt - right.recordedAt || left._creationTime - right._creationTime,
    );
    return { tenantId, meetings, deals: [...deals.values()], payments };
  });
  return { t, ...fixture, deals: new Map(fixture.deals.map((doc) => [doc._id, doc])) };
}

async function createQualificationsFixture() {
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
      tenantId,
      teamId: "T1",
      teamName: "Team",
      isEnterpriseInstall: false,
      appId: "A1",
      botUserId: "B1",
      botAccessToken: "xoxb",
      scopes: [],
      notifyChannelId: "C1",
      notifyChannelName: "qualified",
      installedByWorkosUserId: "user_slack",
      installedAt: 0,
      tokenExpiresAt: 0,
      refreshToken: "r",
      status: "active",
    });
    const slackUser = (slackUserId: string, names: Partial<Doc<"slackUsers">>) =>
      ctx.db.insert("slackUsers", {
        tenantId,
        installationId,
        slackUserId,
        slackTeamId: "T1",
        isBot: false,
        isDeleted: false,
        firstSeenAt: 0,
        lastSeenAt: 0,
        lastSyncedAt: 0,
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
        tenantId,
        slackUserId,
        weekday,
        scheduledHours,
        updatedByUserId: adminId,
        updatedAt: 0,
      });
    }
    const event = (slackUserId: string, submittedAt: number) =>
      ctx.db.insert("slackQualificationEvents", {
        tenantId,
        installationId,
        resultKind: "unlinked",
        qualifiedBy: { slackUserId, slackTeamId: "T1", submittedAt },
        slackUserId,
        slackTeamId: "T1",
        fullNameSnapshot: "Lead",
        platform: "instagram",
        handleSnapshot: "lead",
        submittedAt,
        createdAt: submittedAt,
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
  return { t, ...fixture };
}
describe("Operations across the split", () => {
  it("merges Sales Calls counts, cohorts, currencies and former closers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(businessDayStart("2026-09-16", day) + 20 * HOUR);
    const { t } = await createSalesCallsFixture(["2026-09-14", "2026-09-15", "2026-09-16"]);
    const answers = await expectMergedAnswer({
      t,
      identity,
      live: api.operations.salesCallsDashboard.getSalesCallsDashboard,
      history: range("2026-09-14", "2026-09-15"),
      today: range("2026-09-16", "2026-09-16"),
      whole: range("2026-09-14", "2026-09-16"),
      merge: mergeSalesCallsDashboard,
    });
    expect(answers.history.stats.totalCalls).toBeGreaterThan(0);
    expect(answers.today.stats.totalCalls).toBeGreaterThan(0);
    expect(answers.history.stats.moneyByCurrency.length).toBeGreaterThan(0);
    expect(answers.today.stats.moneyByCurrency.length).toBeGreaterThan(0);
    expect(
      mergeSalesCallsDashboard(
        { ...answers.history, attendanceCountsPartial: true, capped: true },
        answers.today,
      ),
    ).toMatchObject({ attendanceCountsPartial: true, capped: true, stats: { closeRate: null } });
  });

  it("merges Booked Calls with team-only bookings, schedules and whole-range quotas", async () => {
    const t = convexTest({ schema, modules: convexTestModules });
    await t.run(seedBookedCallsFixture);
    const answers = await expectMergedAnswer({
      t,
      identity: BOOKED_CALLS_ADMIN,
      live: api.operations.bookedCallsDashboard.getBookedCallsDashboard,
      history: range("2026-08-13", "2026-08-13"),
      today: range("2026-08-14", "2026-08-14"),
      whole: range("2026-08-13", "2026-08-14"),
      merge: mergeBookedCallsDashboard,
    });
    expect(answers.history.totalBooked).toBeGreaterThan(0);
    expect(answers.today.totalBooked).toBeGreaterThan(0);
    expect(answers.whole.goal.progress).toBeGreaterThan(answers.whole.totalBooked);
    expect(
      mergeBookedCallsDashboard({ ...answers.history, capped: true }, answers.today).capped,
    ).toBe(true);
  });

  it("merges Qualifications with hours, unscheduled openers and latest events", async () => {
    const { t } = await createQualificationsFixture();
    const answers = await expectMergedAnswer({
      t,
      identity,
      live: api.operations.qualificationsDashboard.getQualificationsDashboard,
      history: range("2026-09-14", "2026-09-14"),
      today: range("2026-09-15", "2026-09-15"),
      whole: range("2026-09-14", "2026-09-15"),
      merge: mergeQualificationsDashboard,
    });
    expect(answers.history.totalQualified).toBeGreaterThan(0);
    expect(answers.today.totalQualified).toBeGreaterThan(0);
    expect(
      mergeQualificationsDashboard({ ...answers.history, capped: true }, answers.today).capped,
    ).toBe(true);
  });
});
