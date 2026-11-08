/**
 * Analytics pages now resolve "today", "this week" and "this month" in the
 * browser and send explicit business dates (`kind: "custom"`), so a cached
 * query can't keep yesterday's numbers after the business day turns over.
 * Old tabs keep sending the preset shape after a deploy, so the server must
 * answer both, the same way, for the same day.
 */
import type { FunctionArgs, FunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";
import { insertDmCloser } from "../../tests/bookingCreditFixtures";
import { recordBookingAttribution } from "../lib/attribution/dealAttributions";
import { insertMeetingAggregate } from "../reporting/writeHooks";
import {
  updateLeadGenDailyStats,
  updateLeadGenOriginStats,
  updateLeadGenTeamOriginStats,
} from "../leadGen/aggregates";
import { normalizeLeadGenOrigin } from "../leadGen/normalization";

// The tenant has no businessDay setting: America/Tegucigalpa (UTC-6), days
// start at 01:00, so business day D is [D 07:00Z, D+1 07:00Z).
// 2026-11-05 is a Thursday; its ISO week starts Monday 2026-11-02.
const NOW = Date.parse("2026-11-05T21:40:00Z"); // 15:40 local, Nov 5

const EXPLICIT = {
  today: { kind: "custom", startBusinessDate: "2026-11-05", endBusinessDateInclusive: "2026-11-05" },
  this_week: { kind: "custom", startBusinessDate: "2026-11-02", endBusinessDateInclusive: "2026-11-05" },
  this_month: { kind: "custom", startBusinessDate: "2026-11-01", endBusinessDateInclusive: "2026-11-05" },
} as const;
const PRESETS = ["today", "this_week", "this_month"] as const;
const preset = (name: (typeof PRESETS)[number]) => ({ kind: "preset" as const, preset: name });
const custom = (start: string, end: string) => ({
  kind: "custom" as const,
  startBusinessDate: start,
  endBusinessDateInclusive: end,
});

// One booking, one qualification and one capture at each instant.
const ACTIVITY = {
  today: "2026-11-05T16:00:00Z", // 10:00 local Thu Nov 5
  week: "2026-11-03T16:00:00Z", // Tue Nov 3
  month: "2026-11-01T16:00:00Z", // Sun Nov 1, before this week
  lastMonth: "2026-10-30T16:00:00Z", // Fri Oct 30, outside every range
} as const;
// 00:15 local on Nov 6: still business day Nov 5, which runs until 01:00.
const LATE_NIGHT = "2026-11-06T06:15:00Z";

// How many rows each preset should see, so a deep-equal never passes on two
// empty answers.
const EXPECTED_COUNT = { today: 1, this_week: 2, this_month: 3 } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Seeded = {
  tenantId: Id<"tenants">;
  closerId: Id<"users">;
  adminId: Id<"users">;
  workerId: Id<"leadGenWorkers">;
  teamId: Id<"attributionTeams">;
  dmCloserId: Id<"dmClosers">;
  installationId: Id<"slackInstallations">;
};

async function seedActivity(ctx: MutationCtx, seeded: Seeded, key: string, iso: string) {
  const at = Date.parse(iso);
  const { tenantId } = seeded;

  // A first booking credited to a DM closer, held, projected into the
  // meeting buckets (Overview, Sales Calls, Booked Calls).
  const leadId = await ctx.db.insert("leads", {
    tenantId,
    ...qualifiedLifecycle(at),
    fullName: `Lead ${key}`,
    status: "active",
    firstSeenAt: at,
    updatedAt: at,
  });
  const opportunityId = await ctx.db.insert("opportunities", {
    tenantId,
    leadId,
    stage: "booked",
    outcome: "open",
    source: "calendly",
    assignedCloserId: seeded.closerId,
    createdAt: at,
    updatedAt: at,
  });
  const meetingId = await ctx.db.insert("meetings", {
    tenantId,
    opportunityId,
    assignedCloserId: seeded.closerId,
    calendlyEventUri: `https://api.calendly.com/scheduled_events/${key}`,
    calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${key}/invitees/test`,
    scheduledAt: at,
    durationMinutes: 30,
    status: "held",
    heldMarkedAt: at + 60_000,
    callClassification: "new",
    leadName: `Lead ${key}`,
    createdAt: at,
    attributionResolution: "mapped",
    attributionResolvedAt: at,
  });
  const meeting = await insertMeetingAggregate(ctx, meetingId);
  await recordBookingAttribution(ctx, {
    meeting,
    credit: { teamId: seeded.teamId, dmCloserId: seeded.dmCloserId },
  });

  // A Slack qualification (Overview, Qualifications).
  const qualifiedBy = { slackUserId: "U1", slackTeamId: "T1", submittedAt: at };
  await ctx.db.insert("slackQualificationEvents", {
    tenantId,
    installationId: seeded.installationId,
    leadId,
    resultKind: "unlinked",
    qualifiedBy,
    slackUserId: "U1",
    slackTeamId: "T1",
    fullNameSnapshot: `Lead ${key}`,
    platform: "instagram",
    handleSnapshot: `lead.${key}`,
    submittedAt: at,
    createdAt: at,
  });

  // A lead gen capture by the admin's worker, with its daily and origin
  // rows (Overview, My Activity).
  const worker = (await ctx.db.get("leadGenWorkers", seeded.workerId))!;
  const prospectId = await ctx.db.insert("leadGenProspects", {
    tenantId,
    leadId,
    firstSource: "instagram",
    latestSource: "instagram",
    dedupeKey: `instagram:${key}`,
    normalizedHandle: key,
    rawHandle: key,
    profileUrl: `https://instagram.com/${key}`,
    firstCapturedByWorkerId: worker._id,
    firstCapturedAt: at,
    lastSubmittedByWorkerId: worker._id,
    lastSubmittedAt: at,
    latestOriginKind: "reel",
    contactAttemptCount: 1,
    distinctWorkerCount: 1,
    createdAt: at,
    updatedAt: at,
  });
  const origin = normalizeLeadGenOrigin({
    originKind: "reel",
    originUrlOrLabel: "https://instagram.com/reel/rangeshapes/",
  });
  await ctx.db.insert("leadGenSubmissions", {
    tenantId,
    workerId: worker._id,
    userId: worker.userId,
    teamId: worker.teamId,
    prospectId,
    source: "instagram",
    originKind: "reel",
    originValue: origin.originValue,
    originRankable: true,
    submittedAt: at,
    createdAt: at,
  });
  await updateLeadGenDailyStats(ctx, {
    tenantId,
    worker,
    prospectId,
    source: "instagram",
    submittedAt: at,
    duplicateProspectSubmission: false,
  });
  const originArgs = {
    tenantId,
    teamId: worker.teamId!,
    prospectId,
    source: "instagram" as const,
    originKind: "reel" as const,
    originKey: origin.originKey!,
    originValue: origin.originValue!,
    submittedAt: at,
  };
  await updateLeadGenOriginStats(ctx, originArgs);
  await updateLeadGenTeamOriginStats(ctx, originArgs);
}

async function setup(options: { lateNight?: boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness({ transactionLimits: true, leadGenTeam: true });
  const { t, tenantId } = harness;
  await t.run(async (ctx) => {
    // Reports read the meeting projections only once a tenant is on version 2.
    await ctx.db.patch("tenants", tenantId, { meetingProjectionVersion: 2 });
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(10);
    const admin = users.find((user) => user.role === "tenant_admin")!;
    const closer = users.find((user) => user.role === "closer")!;
    const worker = (await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", tenantId).eq("userId", admin._id))
      .unique())!;
    const teamId = worker.teamId!;
    const dmCloserId = await insertDmCloser(ctx, { tenantId, teamId, name: "Dana" });
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
      botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
      installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
    });
    await ctx.db.insert("slackUsers", {
      tenantId, installationId, slackUserId: "U1", slackTeamId: "T1",
      displayName: "Sam Setter", isBot: false, isDeleted: false,
      firstSeenAt: 0, lastSeenAt: 0, lastSyncedAt: 0,
    });
    const seeded: Seeded = {
      tenantId,
      closerId: closer._id,
      adminId: admin._id,
      workerId: worker._id,
      teamId,
      dmCloserId,
      installationId,
    };
    for (const [key, iso] of Object.entries(ACTIVITY)) {
      await seedActivity(ctx, seeded, key, iso);
    }
    if (options.lateNight) await seedActivity(ctx, seeded, "lateNight", LATE_NIGHT);
  });
  // Run the meeting projection jobs, then put the clock back.
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.setSystemTime(NOW);
  return harness;
}

type Harness = Awaited<ReturnType<typeof setup>>;
type Range = ReturnType<typeof preset> | ReturnType<typeof custom>;

/** Every query under test, called with one range shape. */
function rangeQueries(h: Harness) {
  const { admin } = h;
  return {
    overview: (range: Range) => admin.query(api.dashboard.overview.getOverviewDashboard, { range }),
    leaderboardLeadGen: (range: Range) =>
      admin.query(api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows, { kind: "lead_gen", range }),
    leaderboardQualifiers: (range: Range) =>
      admin.query(api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows, { kind: "qualifiers", range }),
    leaderboardDmClosers: (range: Range) =>
      admin.query(api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows, { kind: "dm_closers", range }),
    salesCalls: (range: Range) =>
      admin.query(api.operations.salesCallsDashboard.getSalesCallsDashboard, { range }),
    bookedCalls: (range: Range) =>
      admin.query(api.operations.bookedCallsDashboard.getBookedCallsDashboard, { range }),
    qualifications: (range: Range) =>
      admin.query(api.operations.qualificationsDashboard.getQualificationsDashboard, { range }),
    myActivity: (range: Range) => admin.query(api.leadGen.activity.getMyActivitySummary, { range }),
    myRecentSubmissions: (range: Range) =>
      admin.query(api.leadGen.activity.listMyRecentSubmissions, {
        range,
        paginationOpts: { cursor: null, numItems: 20 },
      }),
  } satisfies Record<string, (range: Range) => Promise<unknown>>;
}

type Answers = { [K in keyof ReturnType<typeof rangeQueries>]: Awaited<ReturnType<ReturnType<typeof rangeQueries>[K]>> };

async function answerAll(h: Harness, range: Range): Promise<Answers> {
  const queries = rangeQueries(h);
  const entries = await Promise.all(
    Object.entries(queries).map(async ([name, run]) => [name, await run(range)] as const),
  );
  return Object.fromEntries(entries) as Answers;
}

/** The row count each query reports for the range, from the seeded activity. */
function counts(answers: Answers) {
  const { overview } = answers;
  // "empty" still carries data; "error", "capped" and "rebuilding" don't, and
  // two of those would deep-equal without proving anything.
  const { leadGen, topQualifiers, topDmClosers, phoneCloserOperations, topOrigins } = overview;
  for (const section of [leadGen, topQualifiers, topDmClosers, phoneCloserOperations, topOrigins]) {
    if (section.status !== "ready" && section.status !== "empty") {
      throw new Error(`Overview section not loaded: ${JSON.stringify(section)}`);
    }
  }
  if (leadGen.data === null || topQualifiers.data === null || topDmClosers.data === null
    || phoneCloserOperations.data === null) {
    throw new Error("Overview section has no data");
  }
  return {
    overviewLeadGen: leadGen.data.totalSubmissions,
    // Qualification events; totalQualified counts Slack-sourced deals from an
    // aggregate this fixture doesn't seed.
    overviewQualifierEvents: topQualifiers.data.rows.reduce((sum, row) => sum + row.total, 0),
    overviewDmClosers: topDmClosers.data.totalBooked,
    overviewPhoneHeld: phoneCloserOperations.data.totals.held,
    salesCalls: answers.salesCalls.stats.totalCalls,
    bookedCalls: answers.bookedCalls.totalBooked,
    qualifications: answers.qualifications.totalQualified,
    myActivity: answers.myActivity.submissions,
    myRecentSubmissions: answers.myRecentSubmissions.page.length,
  };
}

function allCounts(value: number) {
  return {
    overviewLeadGen: value,
    overviewQualifierEvents: value,
    overviewDmClosers: value,
    overviewPhoneHeld: value,
    salesCalls: value,
    bookedCalls: value,
    qualifications: value,
    myActivity: value,
    myRecentSubmissions: value,
  };
}

describe("dashboard range shapes", () => {
  it.each(PRESETS)("answers preset %s and its explicit dates the same", async (name) => {
    const h = await setup();
    const fromPreset = await answerAll(h, preset(name));
    const fromDates = await answerAll(h, EXPLICIT[name]);

    expect(fromDates).toEqual(fromPreset);
    // Non-trivial: the range's rows are in, the earlier ones are out.
    expect(counts(fromDates)).toEqual(allCounts(EXPECTED_COUNT[name]));
    expect(fromDates.overview.range).toMatchObject({
      startBusinessDate: EXPLICIT[name].startBusinessDate,
      endBusinessDateInclusive: EXPLICIT[name].endBusinessDateInclusive,
    });
    for (const kind of ["leaderboardLeadGen", "leaderboardQualifiers", "leaderboardDmClosers"] as const) {
      expect(fromDates[kind]).toMatchObject({ totalRows: 1 });
    }
  });

  it("keeps the business day until 01:00 local, and lets explicit dates decide the answer", async () => {
    const h = await setup({ lateNight: true });

    // 00:30 local on Nov 6 is still business day Nov 5.
    vi.setSystemTime(Date.parse("2026-11-06T06:30:00Z"));
    const presetToday = await answerAll(h, preset("today"));
    const nov5 = await answerAll(h, custom("2026-11-05", "2026-11-05"));
    expect(nov5).toEqual(presetToday);
    // The 10:00 row and the 00:15 row both belong to Nov 5.
    expect(counts(nov5)).toEqual(allCounts(2));

    // 01:30 local on Nov 6: business day Nov 6 has begun.
    vi.setSystemTime(Date.parse("2026-11-06T07:30:00Z"));
    const nov6 = await answerAll(h, custom("2026-11-06", "2026-11-06"));
    expect(counts(nov6)).toEqual(allCounts(0));
    expect(await answerAll(h, preset("today"))).toEqual(nov6);
    // A tab still showing Nov 5 keeps asking for Nov 5 and still gets it.
    expect(await answerAll(h, custom("2026-11-05", "2026-11-05"))).toEqual(nov5);
  });

  it("accepts a full month of explicit dates and still rejects ranges over 120 days", async () => {
    const h = await setup();
    const october = custom("2026-10-01", "2026-10-31");
    const answers = await answerAll(h, october);
    expect(answers.overview.range).toMatchObject({ dayCount: 31, label: "2026-10-01 to 2026-10-31" });
    // Only the Oct 30 row is in October.
    expect(counts(answers)).toEqual(allCounts(1));

    const tooLong = custom("2026-06-01", "2026-10-31"); // 153 days
    for (const [name, run] of Object.entries(rangeQueries(h))) {
      await expect(run(tooLong), name).rejects.toThrow("Dashboard range cannot exceed 120 days.");
    }
    // The cap counts days: 120 is fine, 121 is not.
    await expect(rangeQueries(h).overview(custom("2026-07-08", "2026-11-04"))).resolves.toMatchObject({
      range: { dayCount: 120 },
    });
    await expect(rangeQueries(h).overview(custom("2026-07-07", "2026-11-04"))).rejects.toThrow(
      "Dashboard range cannot exceed 120 days.",
    );
  });

  it("rejects unauthenticated and wrong-role callers the same way for both shapes", async () => {
    const h = await setup();
    const { t } = h;
    const reject = async <Q extends FunctionReference<"query">>(
      caller: { query: (q: Q, args: FunctionArgs<Q>) => Promise<unknown> },
      fn: Q,
      args: FunctionArgs<Q>,
    ) => {
      try {
        await caller.query(fn, args);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("Query was not rejected");
    };

    for (const fn of [
      api.dashboard.overview.getOverviewDashboard,
      api.operations.bookedCallsDashboard.getBookedCallsDashboard,
    ]) {
      const fromPreset = await reject(t, fn, { range: preset("today") });
      const fromDates = await reject(t, fn, { range: EXPLICIT.today });
      expect(fromDates).toBe(fromPreset);
      expect(fromDates).toMatch(/not authenticated|unauthenticated|sign in/i);
    }

    // A closer of the same tenant is not allowed on the admin dashboards.
    const closerPreset = await reject(h.closer, api.dashboard.overview.getOverviewDashboard, {
      range: preset("today"),
    });
    const closerDates = await reject(h.closer, api.dashboard.overview.getOverviewDashboard, {
      range: EXPLICIT.today,
    });
    expect(closerDates).toBe(closerPreset);
  });
});
