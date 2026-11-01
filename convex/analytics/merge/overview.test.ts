import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { slackQualificationsByUser } from "../../reporting/aggregates";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { businessDateForInstant, businessDayStart, DEFAULT_BUSINESS_DAY } from "../../../lib/businessDay";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { BOOKED_CALLS_ADMIN, seedBookedCallsFixture } from "../../../tests/bookedCallsFixture";
import { bookingHarness, qualifiedLifecycle, testLeadGenTeam } from "../../../tests/bookingHarness";
import { mergeOverviewDashboard, mergeOverviewLeaderboard } from "./overview";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const day = DEFAULT_BUSINESS_DAY;
const admin = { subject: "user_admin", org_id: "org_test" };
const FROM = businessDayStart("2026-10-19", day);
const TO = businessDayStart("2026-10-21", day);
const POST_X = "https://www.instagram.com/p/PostX/";
const REEL_Y = "https://www.instagram.com/reel/ReelY/";
const POST_Z = "https://www.instagram.com/p/PostZ/";
type Harness = Awaited<ReturnType<typeof bookingHarness>>;
afterEach(() => vi.useRealTimers());
const range = (startBusinessDate: string, endBusinessDateInclusive: string) => ({ kind: "custom" as const, startBusinessDate, endBusinessDateInclusive });
const windows = {
  history: { range: range("2026-10-19", "2026-10-19") },
  today: { range: range("2026-10-20", "2026-10-20") },
  whole: { range: range("2026-10-19", "2026-10-20") },
};

async function worker(h: Harness, name: string, teamId: Id<"attributionTeams">) {
  return await h.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      tenantId: h.tenantId,
      workosUserId: name,
      email: `${name}@example.com`,
      role: "lead_generator",
      isActive: true,
    });
    const workerId = await ctx.db.insert("leadGenWorkers", {
      tenantId: h.tenantId,
      userId,
      workosUserId: name,
      email: `${name}@example.com`,
      displayName: name,
      isActive: true,
      teamId,
      createdAt: 0,
      updatedAt: 0,
    });
    return { workerId, userId, identity: { subject: name, org_id: "org_test" } };
  });
}

async function capture(
  h: Harness,
  identity: { subject: string; org_id: string },
  handle: string,
  at: number,
  origin?: { kind: "post" | "reel"; url: string },
) {
  vi.setSystemTime(at);
  return await h.t.withIdentity(identity).mutation(api.leadGen.capture.submit, {
    source: "instagram",
    rawHandleOrProfileUrl: `@${handle}`,
    originKind: origin?.kind ?? "follower",
    ...(origin ? { originUrlOrLabel: origin.url } : {}),
  });
}

async function seedSlack(h: Harness) {
  await h.t.run(async (ctx) => {
    const { tenantId } = h;
    const adminId = (await ctx.db.query("users").take(10)).find((user) => user.workosUserId === "user_admin")!._id;
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1", botUserId: "B1",
      botAccessToken: "token", scopes: [], installedByWorkosUserId: "user_admin", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "refresh", status: "active",
    });
    const setter = (slackUserId: string, fields: Partial<Doc<"slackUsers">>) =>
      ctx.db.insert("slackUsers", {
        tenantId, installationId, slackUserId, slackTeamId: "T1", isBot: false, isDeleted: false,
        firstSeenAt: 0, lastSeenAt: 0, lastSyncedAt: 0, ...fields,
      });
    await setter("U1", { displayName: "Sam Setter" });
    await setter("U2", { realName: "Rita Real" });
    await setter("U3", { username: "scheduled.only" });
    // U1 works Mondays; U3 works Tuesdays and logs nothing.
    for (const [slackUserId, weekday, scheduledHours] of [["U1", "monday", 4], ["U3", "tuesday", 2]] as const) {
      await ctx.db.insert("slackQualifierSchedules", {
        tenantId, slackUserId, weekday, scheduledHours, updatedByUserId: adminId, updatedAt: 0,
      });
    }
    const leadId = await ctx.db.insert("leads", {
      tenantId, ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0,
    });
    // A meeting long before the range, so a deal can be booked.
    const placeholder = await ctx.db.insert("opportunities", {
      tenantId, leadId, stage: "booked", outcome: "open", source: "calendly", createdAt: 0, updatedAt: 0,
    });
    const meetingId = await ctx.db.insert("meetings", {
      tenantId, opportunityId: placeholder, assignedCloserId: adminId,
      calendlyEventUri: "https://example.invalid/event/1", calendlyInviteeUri: "https://example.invalid/invitee/1",
      scheduledAt: FROM - 30 * DAY, durationMinutes: 30, status: "held", createdAt: FROM - 31 * DAY,
    });
    await ctx.db.patch("tenants", tenantId, { meetingProjectionVersion: 2 });
    const deal = async (
      source: Doc<"opportunities">["source"],
      fields: Partial<Doc<"opportunities">> = {},
    ) => {
      const id = await ctx.db.insert("opportunities", {
        tenantId, leadId, stage: "qualified", outcome: "open", source, createdAt: 0, updatedAt: 0, ...fields,
      });
      const doc = (await ctx.db.get("opportunities", id))!;
      if (source === "slack_qualified" && doc.qualifiedBy) await slackQualificationsByUser.insert(ctx, doc);
      return id;
    };
    const qualifiedBy = (slackUserId: string, submittedAt: number) => ({ slackUserId, slackTeamId: "T1", submittedAt });
    const booked = await deal("slack_qualified", { qualifiedBy: qualifiedBy("U1", FROM + 2 * HOUR), latestMeetingId: meetingId });
    const open = await deal("slack_qualified", { qualifiedBy: qualifiedBy("U2", FROM + DAY + 3 * HOUR) });
    const calendly = await deal("calendly", { latestMeetingId: meetingId });
    const earlier = await deal("slack_qualified", { qualifiedBy: qualifiedBy("U1", FROM - 2 * HOUR) });
    const qualify = (
      slackUserId: string,
      submittedAt: number,
      resultKind: Doc<"slackQualificationEvents">["resultKind"],
      opportunityId?: Id<"opportunities">,
    ) =>
      ctx.db.insert("slackQualificationEvents", {
        tenantId, installationId, leadId, opportunityId, resultKind,
        qualifiedBy: qualifiedBy(slackUserId, submittedAt),
        slackUserId, slackTeamId: "T1", fullNameSnapshot: "Lead", platform: "instagram", handleSnapshot: "@lead",
        submittedAt, createdAt: submittedAt,
      });
    await qualify("U2", FROM + HOUR, "unlinked");
    await qualify("U1", FROM + 2 * HOUR, "created_opportunity", booked);
    await qualify("U2", FROM + 3 * HOUR, "duplicate_pending", booked);
    await qualify("U1", FROM + 4 * HOUR, "already_booked", calendly);
    await qualify("U2", FROM + DAY + 3 * HOUR, "created_opportunity", open);
    // U4 has no Slack profile.
    await qualify("U4", FROM + DAY + 4 * HOUR, "unlinked");
    // Before the range.
    await qualify("U1", FROM - 2 * HOUR, "created_opportunity", earlier);
  });
}

async function setupLeadGenAndSlack() {
  vi.useFakeTimers();
  vi.setSystemTime(FROM - 10 * DAY);
  const h = await bookingHarness({ leadGenTeam: true });
  const { teamA, teamB } = await h.t.run(async (ctx) => ({
    teamA: await testLeadGenTeam(ctx, h.tenantId),
    teamB: await testLeadGenTeam(ctx, h.tenantId, "team-b"),
  }));
  const a = await worker(h, "worker_a", teamA);
  const b = await worker(h, "worker_b", teamA);
  const c = await worker(h, "worker_c", teamB);
  await worker(h, "worker_idle", teamB);
  await h.t.run((ctx) =>
    ctx.db.insert("leadGenWorkerSchedules", {
      tenantId: h.tenantId,
      workerId: a.workerId,
      userId: a.userId,
      updatedByUserId: a.userId,
      weekday: "monday",
      scheduledHours: 6,
      updatedAt: 0,
    }),
  );

  // A capture before the range makes p2's later captures duplicates.
  await capture(h, a.identity, "p2", FROM - 2 * HOUR);
  // Day 1. p1's first capture is voided below, so b's earns the credit.
  const voided = await capture(h, a.identity, "p1", FROM + 10 * MINUTE, { kind: "post", url: POST_X });
  await capture(h, b.identity, "p1", FROM + 20 * MINUTE, { kind: "post", url: POST_X });
  await capture(h, b.identity, "p2", FROM + 30 * MINUTE, { kind: "reel", url: REEL_Y });
  await capture(h, a.identity, "p3", FROM + 40 * MINUTE, { kind: "post", url: POST_X });
  await capture(h, c.identity, "p4", FROM + 60 * MINUTE, { kind: "reel", url: REEL_Y });
  await capture(h, c.identity, "p5", FROM + 70 * MINUTE);
  // Day 2.
  await capture(h, a.identity, "p1", FROM + DAY + 10 * MINUTE, { kind: "post", url: POST_Z });
  await capture(h, b.identity, "p6", FROM + DAY + 20 * MINUTE, { kind: "post", url: POST_Z });
  await capture(h, c.identity, "p6", FROM + DAY + 30 * MINUTE, { kind: "post", url: POST_Z });
  // After the range.
  await capture(h, a.identity, "p7", TO + HOUR);

  vi.setSystemTime(FROM + DAY + 2 * HOUR);
  await h.admin.mutation(api.leadGen.corrections.voidSubmission, {
    submissionId: voided.submissionId,
    reason: "test void",
  });
  await seedSlack(h);
  vi.setSystemTime(TO + 2 * HOUR);
  return { h, a, b, c };
}


describe("Overview across the split", () => {
  it("merges dashboard captures, origins, qualifiers and full leaderboards", async () => {
    const { h } = await setupLeadGenAndSlack();
    const answers = await expectMergedAnswer({ t: h.t, identity: admin, live: api.dashboard.overview.getOverviewDashboard, ...windows, merge: mergeOverviewDashboard });
    for (const answer of [answers.history, answers.today]) {
      expect(answer.leadGen.data!.totalSubmissions).toBeGreaterThan(0);
      expect(answer.topQualifiers.data!.totalQualified).toBeGreaterThan(0);
      expect(answer.topOrigins.data!.rows.length).toBeGreaterThan(0);
    }
    expect(answers.whole.range).toMatchObject({ label: "2026-10-19 to 2026-10-20", dayCount: 2 });
    for (const kind of ["lead_gen", "qualifiers"] as const) {
      const rows = await expectMergedAnswer({ t: h.t, identity: admin, live: api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows,
        history: { ...windows.history, kind }, today: { ...windows.today, kind }, whole: { ...windows.whole, kind }, merge: mergeOverviewLeaderboard });
      expect("rows" in rows.history && rows.history.rows.length).toBeGreaterThan(0);
      expect("rows" in rows.today && rows.today.rows.length).toBeGreaterThan(0);
    }
    const ready = answers.today;
    for (const status of ["error", "rebuilding", "capped"] as const) {
      const failed = { ...answers.history, leadGen: { status, data: null, truncated: status === "capped", message: "Unavailable", errorCode: status === "error" ? "unexpected" as const : null } };
      // Construct each union case separately so the section's status stays discriminated.
      const broken = status === "error"
        ? { ...failed, leadGen: { status, data: null, truncated: false as const, message: "Unavailable", errorCode: "unexpected" as const } }
        : status === "capped"
          ? { ...failed, leadGen: { status, data: null, truncated: true as const, message: "Unavailable", errorCode: null } }
          : { ...failed, leadGen: { status, data: null, truncated: false as const, message: "Unavailable", errorCode: null } };
      expect(mergeOverviewDashboard(broken, ready).leadGen.status).toBe(status);
      expect(mergeOverviewDashboard(ready, broken).leadGen.status).toBe(status);
    }
    const capped = { ...ready, topQualifiers: ready.topQualifiers.status === "ready" ? { ...ready.topQualifiers, truncated: true } : ready.topQualifiers };
    expect(mergeOverviewDashboard(capped, ready).topQualifiers.truncated).toBe(true);
  });

  it("merges DM bookings and phone attendance for both business dates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-14T20:00:00Z"));
    const t = convexTest({ schema, modules: convexTestModules });
    await t.run(async (ctx) => {
      const fixture = await seedBookedCallsFixture(ctx);
      await ctx.db.patch("tenants", fixture.tenantId, { meetingProjectionVersion: 2 });
      await ctx.db.patch("meetings", fixture.meetings.firstNorthA, { status: "held" });
      for (const meeting of await ctx.db.query("meetings").take(100)) {
        await ctx.db.patch("meetings", meeting._id, { scheduledAt: meeting.createdAt });
      }
      await ctx.db.patch("meetings", fixture.meetings.outsideWindow, { status: "scheduled" });
      for (const meeting of await ctx.db.query("meetings").take(100)) {
        await ctx.db.insert("operationsMeetingStatsV2", {
          tenantId: fixture.tenantId, dayKey: businessDateForInstant(meeting.scheduledAt, day),
          assignedCloserId: meeting.assignedCloserId, bookingProgramId: meeting.bookingProgramId,
          meetingStatus: meeting.status, bucketKey: meeting._id, count: 1, updatedAt: 0,
        });
      }
    });
    const dates = {
      history: { range: range("2026-08-13", "2026-08-13") },
      today: { range: range("2026-08-14", "2026-08-14") },
      whole: { range: range("2026-08-13", "2026-08-14") },
    };
    const answers = await expectMergedAnswer({ t, identity: BOOKED_CALLS_ADMIN, live: api.dashboard.overview.getOverviewDashboard, ...dates, merge: mergeOverviewDashboard });
    for (const answer of [answers.history, answers.today]) {
      expect(answer.topDmClosers.data!.totalBooked).toBeGreaterThan(0);
      expect(answer.phoneCloserOperations.data!.totals.scheduled).toBeGreaterThan(0);
    }
    await expectMergedAnswer({ t, identity: BOOKED_CALLS_ADMIN, live: api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows,
      history: { ...dates.history, kind: "dm_closers" }, today: { ...dates.today, kind: "dm_closers" }, whole: { ...dates.whole, kind: "dm_closers" }, merge: mergeOverviewLeaderboard });
  });
  it("re-ranks the available top-five worker candidates when each side was cut", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROM - DAY);
    const h = await bookingHarness({ leadGenTeam: true });
    const teamId = await h.t.run((ctx) => testLeadGenTeam(ctx, h.tenantId));
    for (let index = 0; index < 7; index += 1) {
      const person = await worker(h, `rank_${index}`, teamId);
      await h.t.run(async (ctx) => {
        for (const weekday of ["monday", "tuesday"] as const) {
          await ctx.db.insert("leadGenWorkerSchedules", {
            tenantId: h.tenantId, workerId: person.workerId, userId: person.userId,
            updatedByUserId: person.userId, weekday, scheduledHours: 4, updatedAt: 0,
          });
        }
      });
      // Seed the daily buckets here; the earlier fixture covers capture hooks.
      await h.t.run(async (ctx) => {
        for (const [dayKey, submissions] of [["2026-10-19", 7 - index], ["2026-10-20", index + 1]] as const) {
          await ctx.db.insert("leadGenDailyStats", {
            tenantId: h.tenantId, statKey: `${person.workerId}:${dayKey}`, dayKey,
            workerId: person.workerId, userId: person.userId, teamId, source: "instagram",
            submissions, uniqueProspectsSubmitted: submissions, duplicateProspectSubmissions: 0,
            scheduledHours: 4, updatedAt: FROM,
          });
        }
      });
    }
    const whole = await h.admin.query(api.dashboard.overview.getOverviewDashboard, windows.whole);
    const answers = await expectMergedAnswer({
      t: h.t, identity: admin, live: api.dashboard.overview.getOverviewDashboard, ...windows,
      merge: (history, today) => {
        const result = mergeOverviewDashboard(history, today);
        return { ...result, leadGen: result.leadGen.data && whole.leadGen.data ? { ...result.leadGen, data: { ...result.leadGen.data, topWorkers: whole.leadGen.data.topWorkers } } : result.leadGen };
      },
    });
    expect(answers.history.leadGen.data!.topWorkers).toHaveLength(5);
    expect(answers.today.leadGen.data!.topWorkers).toHaveLength(5);
    const candidates = new Map(answers.history.leadGen.data!.topWorkers.map((row) => [row.workerId, row]));
    for (const row of answers.today.leadGen.data!.topWorkers) {
      const past = candidates.get(row.workerId);
      const submissions = (past?.submissions ?? 0) + row.submissions;
      const scheduledHours = (past?.scheduledHours ?? 0) + row.scheduledHours;
      candidates.set(row.workerId, { ...row, submissions, scheduledHours, leadsPerHour: submissions / scheduledHours });
    }
    const expected = [...candidates.values()].sort((left, right) => right.leadsPerHour! - left.leadsPerHour! || right.submissions - left.submissions || left.displayName.localeCompare(right.displayName)).slice(0, 5);
    expect(mergeOverviewDashboard(answers.history, answers.today).leadGen.data!.topWorkers).toEqual(expected);
    for (const row of expected) expect(row.leadsPerHour).toBeCloseTo(row.submissions / row.scheduledHours);
  });

  it("sums booked qualifier distinct counts when a deal appears in both windows", async () => {
    const { h } = await setupLeadGenAndSlack();
    await h.t.run(async (ctx) => {
      const original = (await ctx.db.query("slackQualificationEvents").take(100)).find((row) => row.slackUserId === "U2" && row.opportunityId)!;
      const { _id: _id, _creationTime: _time, ...fields } = original;
      await ctx.db.insert("slackQualificationEvents", { ...fields, submittedAt: FROM + DAY + HOUR, createdAt: FROM + DAY + HOUR });
    });
    const whole = await h.admin.query(api.dashboard.overview.getOverviewDashboard, windows.whole);
    const answers = await expectMergedAnswer({
      t: h.t, identity: admin, live: api.dashboard.overview.getOverviewDashboard, ...windows,
      merge: (history, today) => {
        const result = mergeOverviewDashboard(history, today);
        if (result.topQualifiers.data && whole.topQualifiers.data) {
          result.topQualifiers.data.rows = result.topQualifiers.data.rows.map((row) => {
            const exact = whole.topQualifiers.data!.rows.find((candidate) => candidate.slackUserId === row.slackUserId)!;
            return { ...row, booked: exact.booked, ratio: exact.ratio };
          });
        }
        return result;
      },
    });
    const merged = mergeOverviewDashboard(answers.history, answers.today).topQualifiers.data!;
    const row = merged.rows.find((candidate) => candidate.slackUserId === "U2")!;
    expect(row.booked).toBe(2);
    expect(row.ratio).toBeCloseTo(row.booked / row.uniqueOpportunityCount);
    const kind = "qualifiers" as const;
    const all = await h.admin.query(api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows, { ...windows.whole, kind });
    const normalize = (answer: typeof all) => {
      if (!("rows" in answer) || answer.kind !== "qualifiers" || !("rows" in all) || all.kind !== "qualifiers") return answer;
      return { ...answer, rows: answer.rows.map((candidate) => {
        const exact = all.rows.find((item) => item.slackUserId === candidate.slackUserId)!;
        return { ...candidate, booked: exact.booked, ratio: exact.ratio };
      }) };
    };
    await expectMergedAnswer({ t: h.t, identity: admin, live: api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows,
      history: { ...windows.history, kind }, today: { ...windows.today, kind }, whole: { ...windows.whole, kind },
      merge: (history, today) => {
        const result = mergeOverviewLeaderboard(history, today);
        if ("rows" in result && result.kind === "qualifiers") {
          const approximate = result.rows.find((candidate) => candidate.slackUserId === "U2")!;
          expect(approximate.booked).toBe(2);
          expect(approximate.ratio).toBeCloseTo(approximate.booked / approximate.uniqueOpportunityCount);
        }
        return normalize(result);
      } });
  });

});
