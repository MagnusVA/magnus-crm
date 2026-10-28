import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { LEAD_CAPTURE_VOIDED } from "../../leadGen/prospectPeople";
import { slackQualificationsByUser } from "../../reporting/aggregates";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import {
  addBusinessDays,
  businessDateForInstant,
  businessDayStart,
  DEFAULT_BUSINESS_DAY,
} from "../../../lib/businessDay";
import { expectSameAnswer } from "../../../tests/analyticsParity";
import { BOOKED_CALLS_ADMIN, seedBookedCallsFixture } from "../../../tests/bookedCallsFixture";
import { bookingHarness, qualifiedLifecycle, testLeadGenTeam } from "../../../tests/bookingHarness";

// The Overview from ClickHouse rows. Captures and voids go through the real
// mutations, so the reader sees the lead gen buckets the hooks keep; the
// meeting buckets and the Slack aggregate are written as their hooks would.
// The rows handed to `finalize` come from a model of the report SQL over the
// same documents.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const day = DEFAULT_BUSINESS_DAY;
const admin = { subject: "user_admin", org_id: "org_test" };

type OverviewDashboard = FunctionReturnType<typeof api.dashboard.overview.getOverviewDashboard>;

function businessRange(startDate: string, endDateInclusive: string) {
  return {
    startDate,
    endDateInclusive,
    fromMs: businessDayStart(startDate, day),
    toMs: businessDayStart(addBusinessDays(endDateInclusive, 1), day),
    timeZone: day.timeZone,
    dayStartHour: day.dayStartHour,
  };
}

type Range = ReturnType<typeof businessRange>;

function liveRange(range: Range) {
  return { kind: "custom", startBusinessDate: range.startDate, endBusinessDateInclusive: range.endDateInclusive };
}

function before(left: readonly (number | string)[], right: readonly (number | string)[]) {
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i];
  }
  return false;
}

function first<T>(rows: T[], key: (row: T) => readonly (number | string)[]) {
  return rows.reduce((best, row) => (before(key(row), key(best)) ? row : best));
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return [...groups.values()];
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

afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// Lead gen and Slack qualifiers
// ---------------------------------------------------------------------------

// Monday 2026-10-19 and Tuesday 2026-10-20.
const range = businessRange("2026-10-19", "2026-10-20");
const FROM = range.fromMs;
const TO = range.toMs;
const POST_X = "https://www.instagram.com/p/PostX/";
const REEL_Y = "https://www.instagram.com/reel/ReelY/";
const POST_Z = "https://www.instagram.com/p/PostZ/";

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

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

async function loadModel(h: Harness) {
  return await h.t.run(async (ctx) => {
    const voided = new Set(
      (await ctx.db.query("domainEvents").take(1000))
        .filter((event) => event.eventType === LEAD_CAPTURE_VOIDED)
        .map((event) => (JSON.parse(event.metadata!) as { submissionId: string }).submissionId),
    );
    const captures = (await ctx.db.query("leadGenSubmissions").take(1000)).map((row) => ({
      id: row._id as string,
      prospect_id: row.prospectId as string,
      worker_id: row.workerId as string,
      team_id: (row.teamId ?? null) as string | null,
      source: row.source,
      origin_rankable: row.originRankable,
      origin_kind: row.originKind as string,
      origin_value: row.originValue ?? null,
      at: [row.submittedAt, row._creationTime] as const,
      day_key: businessDateForInstant(row.submittedAt, day),
      active: !voided.has(row._id),
    }));
    return {
      captures,
      events: await ctx.db.query("slackQualificationEvents").take(1000),
      deals: await ctx.db.query("opportunities").take(1000),
    };
  });
}

type Model = Awaited<ReturnType<typeof loadModel>>;

const inRange = (model: Model) => model.captures.filter((row) => row.at[0] >= FROM && row.at[0] < TO);

/** dailyStatsSql with no filters. */
function dailyRows(model: Model) {
  const captures = inRange(model);
  const credited = new Set(
    groupBy(captures.filter((row) => row.active), (row) => `${row.prospect_id}:${row.day_key}`).map(
      (rows) => first(rows, (row) => row.at).id,
    ),
  );
  const firstAttempts = new Set(
    groupBy(model.captures, (row) => row.prospect_id).map((rows) => first(rows, (row) => row.at).id),
  );
  return groupBy(captures, (row) => [row.day_key, row.worker_id, row.team_id, row.source].join(":"))
    .map((rows) => ({
      day_key: rows[0].day_key,
      worker_id: rows[0].worker_id,
      team_id: rows[0].team_id,
      source: rows[0].source,
      submissions: rows.filter((row) => row.active).length,
      unique_prospects: rows.filter((row) => row.active && credited.has(row.id)).length,
      duplicates: rows.filter((row) => row.active && !firstAttempts.has(row.id)).length,
      order: [rows[0].day_key, ...first(rows, (row) => row.at).at] as const,
    }))
    .sort((left, right) => (before(left.order, right.order) ? -1 : 1))
    .map(({ order: _order, ...row }) => row);
}

/** topOriginsSql: per-day origin buckets summed per source and origin, the top ten with ties. */
function originRows(model: Model) {
  const captures = inRange(model)
    .filter((row) => row.origin_rankable && ["post", "reel"].includes(row.origin_kind) && row.origin_value)
    .map((row) => ({ ...row, origin_key: row.origin_value!.toLowerCase() }));
  const days = groupBy(captures, (row) => `${row.origin_key}:${row.day_key}`).map((group) => {
    const head = first(group, (row) => row.at);
    const active = group.filter((row) => row.active);
    return {
      head,
      seen: [head.day_key, ...head.at] as const,
      submissions: active.length,
      unique_prospects: new Set(active.map((row) => row.prospect_id)).size,
    };
  });
  const origins = groupBy(days, (entry) => `${entry.head.source}:${entry.head.origin_key}`).map((group) => {
    const head = first(group, (entry) => entry.seen);
    return {
      row: {
        source: head.head.source,
        origin_key: head.head.origin_key,
        first_kind: head.head.origin_kind,
        first_value: head.head.origin_value,
        submissions: group.reduce((sum, entry) => sum + entry.submissions, 0),
        unique_prospects: group.reduce((sum, entry) => sum + entry.unique_prospects, 0),
      },
      seen: head.seen,
    };
  });
  const rank = (entry: (typeof origins)[number]) =>
    1 +
    origins.filter(
      (other) =>
        other.row.submissions > entry.row.submissions ||
        (other.row.submissions === entry.row.submissions && other.row.unique_prospects > entry.row.unique_prospects),
    ).length;
  return origins
    .filter((entry) => rank(entry) <= 10)
    .sort((left, right) => (before(left.seen, right.seen) ? -1 : 1))
    .map((entry) => entry.row);
}

/** qualifierEventsSql and qualifiedDealsSql. */
function qualifierRows(model: Model) {
  const bookedSlackDeals = new Set(
    model.deals
      .filter((deal) => deal.source === "slack_qualified" && deal.latestMeetingId !== undefined)
      .map((deal) => deal._id as string),
  );
  const events = model.events
    .filter((event) => event.submittedAt >= FROM && event.submittedAt < TO)
    .sort((left, right) => left.submittedAt - right.submittedAt || left._creationTime - right._creationTime);
  const qualifiers = groupBy(events, (event) => event.slackUserId).map((own) => ({
    slack_user_id: own[0].slackUserId,
    total: own.length,
    booked: new Set(own.flatMap((event) => (event.opportunityId && bookedSlackDeals.has(event.opportunityId) ? [event.opportunityId] : []))).size,
  }));
  const qualifiedDeals = model.deals.filter(
    (deal) => deal.source === "slack_qualified" && deal.qualifiedBy &&
      deal.qualifiedBy.submittedAt >= FROM && deal.qualifiedBy.submittedAt < TO,
  );
  const qualified = groupBy(qualifiedDeals, (deal) => deal.qualifiedBy!.slackUserId).map((own) => ({
    slack_user_id: own[0].qualifiedBy!.slackUserId,
    qualified: own.length,
  }));
  return { qualifiers, qualified };
}

describe("Overview from ClickHouse rows: lead gen and qualifiers", () => {
  it("matches the Convex reader and its expanded leaderboards", async () => {
    const { h, a, b, c } = await setupLeadGenAndSlack();
    const model = await loadModel(h);
    const { qualifiers, qualified } = qualifierRows(model);

    const dashboard: OverviewDashboard = await expectSameAnswer({
      t: h.t,
      identity: admin,
      tenantId: h.tenantId,
      range,
      reportId: "overview.dashboard",
      live: api.dashboard.overview.getOverviewDashboard,
      liveArgs: { range: liveRange(range) },
      filters: {},
      rows: {
        daily: dailyRows(model),
        origins: originRows(model),
        qualifiers,
        qualified,
        bookings: [],
        buckets: [],
      },
    });
    expect(dashboard.leadGen).toMatchObject({ status: "ready", data: { totalSubmissions: 8 } });
    expect(dashboard.leadGen.data?.topWorkers.map((row) => row.workerId)).toEqual([a.workerId, b.workerId, c.workerId]);
    expect(dashboard.topQualifiers.data?.rows.map((row) => [row.slackUserId, row.total, row.uniqueOpportunityCount, row.booked])).toEqual([
      ["U1", 2, 1, 1],
      ["U3", 0, 0, 0],
      ["U2", 3, 1, 1],
      ["U4", 1, 0, 0],
    ]);
    // Post X and Reel Y tie, so the value breaks it.
    expect(dashboard.topOrigins.data?.rows.map((row) => [row.originKey, row.submissions, row.uniqueProspects])).toEqual([
      ["https://www.instagram.com/p/postz/", 3, 2],
      ["https://www.instagram.com/p/postx/", 2, 2],
      ["https://www.instagram.com/reel/reely/", 2, 2],
    ]);
    expect(dashboard.phoneCloserOperations.status).toBe("empty");

    const leaderboard = async (filters: Record<string, string>, rows: Record<string, Array<Record<string, unknown>>>) => {
      const { kind, ...rest } = filters;
      return await expectSameAnswer({
        t: h.t,
        identity: admin,
        tenantId: h.tenantId,
        range,
        reportId: "overview.leaderboard",
        live: api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows,
        liveArgs: { kind, range: liveRange(range), ...(Object.keys(rest).length > 0 ? { filters: rest } : {}) },
        filters,
        rows,
      });
    };
    const daily = { daily: dailyRows(model) };
    const leadGen = await leaderboard({ kind: "lead_gen" }, daily);
    // Every worker shows: the harness's admin worker and the idle one too.
    expect(leadGen).toMatchObject({ kind: "lead_gen", totalRows: 5, filteredRows: 5 });
    expect(await leaderboard({ kind: "lead_gen", activity: "without_activity" }, daily)).toMatchObject({ filteredRows: 2 });
    expect(await leaderboard({ kind: "lead_gen", search: " WORKER_B " }, daily)).toMatchObject({ filteredRows: 1 });

    expect(await leaderboard({ kind: "qualifiers" }, { qualifiers, qualified })).toMatchObject({ totalRows: 4 });
    expect(await leaderboard({ kind: "qualifiers", schedule: "scheduled" }, { qualifiers, qualified })).toMatchObject({
      filteredRows: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// DM closers and phone closers
// ---------------------------------------------------------------------------

/** What `bookingCreditCountsSql` returns for the fixture's documents. */
function bookingCreditRows(
  meetings: Doc<"meetings">[],
  attributions: Doc<"dealAttributions">[],
  window: Range,
) {
  const latest = new Map<string, Doc<"dealAttributions">>();
  for (const row of attributions) {
    if (
      !row.meetingId ||
      (row.role !== "dm_team" && row.role !== "dm_closer") ||
      row.source.kind !== "booking_utm" ||
      row.attributedAt < window.fromMs ||
      row.attributedAt >= window.toMs ||
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
    if (meeting.createdAt < window.fromMs || meeting.createdAt >= window.toMs) continue;
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

/** What `meetingBucketsSql` returns: days before `recent_from` folded into the first. */
function meetingBucketRows(
  meetings: Doc<"meetings">[],
  deals: Map<Id<"opportunities">, Doc<"opportunities">>,
  window: Range,
) {
  const recentFrom = addBusinessDays(businessDateForInstant(Date.now(), day), -2);
  const buckets = new Map<string, { key: (string | null)[]; count: number }>();
  for (const meeting of meetings) {
    const deal = deals.get(meeting.opportunityId);
    if (!deal || meeting.scheduledAt < window.fromMs || meeting.scheduledAt >= window.toMs) continue;
    const date = businessDateForInstant(meeting.scheduledAt, day);
    const key = [
      date < recentFrom ? window.startDate : date,
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

async function setupBookings() {
  const t = convexTest({ schema, modules: convexTestModules });
  const fixture = await t.run(async (ctx) => {
    const seeded = await seedBookedCallsFixture(ctx);
    await ctx.db.patch("tenants", seeded.tenantId, { meetingProjectionVersion: 2 });
    await ctx.db.patch("meetings", seeded.meetings.firstNorthA, { status: "held" });
    await ctx.db.patch("meetings", seeded.meetings.firstNorthA2, { status: "no_show" });
    await ctx.db.patch("meetings", seeded.meetings.noUtm, { status: "canceled" });
    const meetings = await ctx.db.query("meetings").take(100);
    const deals = new Map((await ctx.db.query("opportunities").take(100)).map((doc) => [doc._id, doc]));
    // The buckets the projection keeps.
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
        tenantId: seeded.tenantId,
        dayKey: bucket.dayKey,
        assignedCloserId: bucket.meeting.assignedCloserId,
        bookingProgramId: bucket.meeting.bookingProgramId,
        soldProgramId: deals.get(bucket.meeting.opportunityId)?.soldProgramId,
        meetingStatus: bucket.meeting.status,
        bucketKey,
        count: bucket.count,
        updatedAt: 0,
      });
    }
    return {
      seeded,
      meetings,
      deals: [...deals.values()],
      attributions: await ctx.db.query("dealAttributions").take(200),
    };
  });
  return { t, ...fixture, deals: new Map(fixture.deals.map((doc) => [doc._id, doc])) };
}

describe("Overview from ClickHouse rows: DM closers and phone closers", () => {
  it("matches the Convex reader and the DM closer leaderboard", async () => {
    const { t, seeded, meetings, deals, attributions } = await setupBookings();
    const window = businessRange("2026-08-13", "2026-08-15");
    const bookings = bookingCreditRows(meetings, attributions, window);

    const dashboard: OverviewDashboard = await expectSameAnswer({
      t,
      identity: BOOKED_CALLS_ADMIN,
      tenantId: seeded.tenantId,
      range: window,
      reportId: "overview.dashboard",
      live: api.dashboard.overview.getOverviewDashboard,
      liveArgs: { range: liveRange(window) },
      filters: {},
      rows: {
        daily: [],
        origins: [],
        qualifiers: [],
        qualified: [],
        bookings,
        buckets: meetingBucketRows(meetings, deals, window),
      },
    });
    expect(dashboard.topDmClosers).toMatchObject({ status: "ready", data: { totalBooked: 4 } });
    expect(dashboard.phoneCloserOperations).toMatchObject({
      status: "ready",
      data: { totals: { held: 1, noShows: 1 } },
    });
    expect(dashboard.leadGen.status).toBe("empty");

    const leaderboard = async (filters: Record<string, string>) => {
      const { kind, ...rest } = filters;
      return await expectSameAnswer({
        t,
        identity: BOOKED_CALLS_ADMIN,
        tenantId: seeded.tenantId,
        range: window,
        reportId: "overview.leaderboard",
        live: api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows,
        liveArgs: { kind, range: liveRange(window), ...(Object.keys(rest).length > 0 ? { filters: rest } : {}) },
        filters,
        rows: { bookings },
      });
    };
    expect(await leaderboard({ kind: "dm_closers" })).toMatchObject({ kind: "dm_closers", truncated: false });
    expect(await leaderboard({ kind: "dm_closers", activity: "with_activity", schedule: "scheduled" })).toMatchObject({
      kind: "dm_closers",
    });
  });
});
