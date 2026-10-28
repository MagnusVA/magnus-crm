import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { recordDealCreation } from "../../lib/attribution/dealAttributions";
import { LEAD_CAPTURE_VOIDED } from "../../leadGen/prospectPeople";
import { LIFECYCLE_STAGES } from "../../leads/lifecycle";
import { businessDateForInstant } from "../../../lib/businessDay";
import { bookingHarness, testLeadGenTeam } from "../../../tests/bookingHarness";
import { expectSameAnswer } from "../../../tests/analyticsParity";

// Lead gen reports from ClickHouse rows. The captures, voids and Respark work
// go through the real mutations, so the Convex readers see the buckets and
// aggregates the write hooks keep. The rows handed to `finalize` come from a
// model of the report SQL (leadGenShared.ts, leadGenOrigins.ts,
// leadGenPeople.ts) over the same documents, so each test proves the
// unique-credit rule and the builders agree with what the hooks wrote.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Business days 2026-10-19 and 2026-10-20 (Tegucigalpa, from 01:00).
const FROM = Date.UTC(2026, 9, 19, 7);
const TO = Date.UTC(2026, 9, 21, 7);
const range = {
  startDate: "2026-10-19",
  endDateInclusive: "2026-10-20",
  fromMs: FROM,
  toMs: TO,
  timeZone: "America/Tegucigalpa",
  dayStartHour: 1,
};
const dayKeys = { startDayKey: "2026-10-19", endDayKey: "2026-10-20" };
const POST_X = "https://www.instagram.com/p/PostX/";
const REEL_Y = "https://www.instagram.com/reel/ReelY/";
const POST_Z = "https://www.instagram.com/p/PostZ/";

type Harness = Awaited<ReturnType<typeof bookingHarness>>;
type Source = Doc<"leadGenSubmissions">["source"];

afterEach(() => vi.useRealTimers());

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
  source: Source = "instagram",
) {
  vi.setSystemTime(at);
  return await h.t.withIdentity(identity).mutation(api.leadGen.capture.submit, {
    source,
    rawHandleOrProfileUrl: `@${handle}`,
    originKind: origin?.kind ?? "follower",
    ...(origin ? { originUrlOrLabel: origin.url } : {}),
  });
}

/** Claims a batch and works its first open item. */
async function work(
  h: Harness,
  identity: { subject: string; org_id: string },
  at: number,
  result: "resparked" | "not_a_fit",
) {
  vi.setSystemTime(at);
  const caller = h.t.withIdentity(identity);
  const batch = await caller.mutation(api.respark.batches.claimResparkBatch, {});
  const item = await h.t.run(async (ctx) =>
    (
      await ctx.db
        .query("resparkBatchItems")
        .withIndex("by_batchId_and_position", (q) => q.eq("batchId", batch.batchId!))
        .take(100)
    ).find((row) => !row.result),
  );
  if (!item) throw new Error("No unworked pool item");
  await caller.mutation(
    result === "resparked" ? api.respark.batches.markResparked : api.respark.batches.markNotAFit,
    { itemId: item._id },
  );
  return item;
}

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(FROM - 50 * DAY);
  const h = await bookingHarness({ leadGenTeam: true });
  const { teamA, teamB } = await h.t.run(async (ctx) => {
    await ctx.db.patch("tenants", h.tenantId, { respark: { inactiveAfterDays: 30, batchSize: 1 } });
    return { teamA: await testLeadGenTeam(ctx, h.tenantId), teamB: await testLeadGenTeam(ctx, h.tenantId, "team-b") };
  });
  const a = await worker(h, "worker_a", teamA);
  const b = await worker(h, "worker_b", teamA);
  const c = await worker(h, "worker_c", teamB);
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
  const admin = { subject: "user_admin", org_id: "org_test" };

  // The Respark pool: people captured long before the range.
  for (let i = 0; i < 4; i++) await capture(h, admin, `pool.${i}`, FROM - (45 + i) * DAY);
  // A capture before the range makes p2's later captures duplicates.
  await capture(h, a.identity, "p2", FROM - 2 * HOUR);

  // Day 1. p1's first capture (a) is voided below, so b's earns the credit.
  const voided = await capture(h, a.identity, "p1", FROM + 10 * MINUTE, { kind: "post", url: POST_X });
  await capture(h, b.identity, "p1", FROM + 20 * MINUTE, { kind: "post", url: POST_X });
  await capture(h, b.identity, "p2", FROM + 30 * MINUTE, { kind: "reel", url: REEL_Y });
  await capture(h, a.identity, "p3", FROM + 40 * MINUTE, { kind: "post", url: POST_X });
  await capture(h, a.identity, "p3", FROM + 50 * MINUTE, undefined, "meta_business");
  await capture(h, c.identity, "p4", FROM + 60 * MINUTE, { kind: "reel", url: REEL_Y });
  // c's only Meta Business capture of the day is voided: its row stays at zero.
  const voidedAlone = await capture(h, c.identity, "p5", FROM + 70 * MINUTE, undefined, "meta_business");
  // Day 2.
  await capture(h, a.identity, "p1", FROM + DAY + 10 * MINUTE, { kind: "post", url: POST_Z });
  await capture(h, b.identity, "p6", FROM + DAY + 20 * MINUTE, { kind: "post", url: POST_Z });
  await capture(h, c.identity, "p6", FROM + DAY + 30 * MINUTE, { kind: "post", url: POST_Z });
  // After the range.
  await capture(h, a.identity, "p7", TO + HOUR);

  vi.setSystemTime(FROM + DAY + 2 * HOUR);
  for (const submission of [voided, voidedAlone]) {
    await h.admin.mutation(api.leadGen.corrections.voidSubmission, {
      submissionId: submission.submissionId,
      reason: "test void",
    });
  }

  // Respark: a resparks one person whose deal is booked, and marks one not a fit.
  const resparked = await work(h, a.identity, FROM + 3 * HOUR, "resparked");
  await work(h, a.identity, FROM + 4 * HOUR, "not_a_fit");
  await h.t.run(async (ctx) => {
    const at = FROM + 5 * HOUR;
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId: h.tenantId,
      leadId: resparked.leadId,
      stage: "qualified",
      outcome: "open",
      source: "slack_qualified",
      createdAt: at,
      updatedAt: at,
      firstBookedAt: at,
    });
    await recordDealCreation(ctx, opportunityId);
  });
  // A deal for p4, credited to c's capture.
  await h.t.run(async (ctx) => {
    const p4 = (await ctx.db.query("leadGenSubmissions").take(100)).find(
      (row) => row.workerId === c.workerId && row.submittedAt === FROM + 60 * MINUTE,
    )!;
    const prospect = (await ctx.db.get("leadGenProspects", p4.prospectId))!;
    const at = FROM + 6 * HOUR;
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId: h.tenantId,
      leadId: prospect.leadId!,
      stage: "qualified",
      outcome: "open",
      source: "slack_qualified",
      createdAt: at,
      updatedAt: at,
    });
    await recordDealCreation(ctx, opportunityId);
  });
  vi.setSystemTime(TO + 2 * HOUR);
  return { h, a, b, c, teamA, teamB };
}

// ---- A model of the report SQL over the Convex documents ----

type Capture = {
  id: string;
  prospect_id: string;
  worker_id: string;
  team_id: string | null;
  source: Source;
  origin_rankable: boolean;
  origin_kind: string;
  origin_value: string | null;
  at: [number, number];
  day_key: string;
  active: boolean;
};

type Filters = { teamId?: string | null; workerId?: string | null; source?: string | null };

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

function matches(row: Capture, filters: Filters) {
  return (
    (!filters.workerId || row.worker_id === filters.workerId) &&
    (!filters.teamId || row.team_id === filters.teamId) &&
    (!filters.source || row.source === filters.source)
  );
}

async function loadModel(h: Harness) {
  return await h.t.run(async (ctx) => {
    const events = await ctx.db.query("domainEvents").take(1000);
    const voided = new Set(
      events
        .filter((event) => event.eventType === LEAD_CAPTURE_VOIDED)
        // Metadata is stored as JSON text, as ClickHouse reads it.
        .map((event) => (JSON.parse(event.metadata!) as { submissionId: string }).submissionId),
    );
    const captures: Capture[] = (await ctx.db.query("leadGenSubmissions").take(1000)).map((row) => ({
      id: row._id,
      prospect_id: row.prospectId,
      worker_id: row.workerId,
      team_id: row.teamId ?? null,
      source: row.source,
      origin_rankable: row.originRankable,
      origin_kind: row.originKind,
      origin_value: row.originValue ?? null,
      at: [row.submittedAt, row._creationTime],
      day_key: businessDateForInstant(row.submittedAt, { timeZone: range.timeZone, dayStartHour: range.dayStartHour }),
      active: !voided.has(row._id),
    }));
    return {
      captures,
      prospects: await ctx.db.query("leadGenProspects").take(1000),
      people: await ctx.db.query("leads").take(1000),
      attributions: await ctx.db.query("dealAttributions").take(1000),
      deals: await ctx.db.query("opportunities").take(1000),
      resparkItems: await ctx.db.query("resparkBatchItems").take(1000),
    };
  });
}

type Model = Awaited<ReturnType<typeof loadModel>>;

const inRange = (model: Model) => model.captures.filter((row) => row.at[0] >= FROM && row.at[0] < TO);

function dailyRows(model: Model, filters: Filters) {
  const captures = inRange(model);
  const credited = new Set(
    groupBy(captures.filter((row) => row.active), (row) => `${row.prospect_id}:${row.day_key}`).map(
      (rows) => first(rows, (row) => row.at).id,
    ),
  );
  const firstAttempts = new Set(
    groupBy(model.captures, (row) => row.prospect_id).map((rows) => first(rows, (row) => row.at).id),
  );
  return groupBy(
    captures.filter((row) => matches(row, filters)),
    (row) => [row.day_key, row.worker_id, row.team_id, row.source].join(":"),
  )
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

function originCaptures(model: Model) {
  return inRange(model)
    .filter((row) => row.origin_rankable && ["post", "reel"].includes(row.origin_kind) && row.origin_value)
    .map((row) => ({ ...row, origin_key: row.origin_value!.toLowerCase() }));
}

type OriginCapture = ReturnType<typeof originCaptures>[number];

function originDays(rows: OriginCapture[], key: (row: OriginCapture) => string) {
  return groupBy(rows, (row) => `${key(row)}:${row.origin_key}:${row.day_key}`).map((group) => {
    const head = first(group, (row) => row.at);
    const active = group.filter((row) => row.active);
    return {
      head,
      day_key: head.day_key,
      origin_key: head.origin_key,
      first_at: head.at,
      submissions: active.length,
      unique_prospects: new Set(active.map((row) => row.prospect_id)).size,
    };
  });
}

function topOriginRows(model: Model, filters: Filters & { limit: number }) {
  const captures = originCaptures(model);
  let entries;
  if (filters.teamId || filters.workerId) {
    entries = groupBy(
      captures.filter((row) => row.active && matches(row, filters)),
      (row) => `${row.source}:${row.origin_key}`,
    ).map((rows) => {
      const head = first(rows, (row) => row.at);
      return {
        row: {
          source: head.source,
          origin_key: head.origin_key,
          first_kind: head.origin_kind,
          first_value: head.origin_value,
          submission_count: rows.length,
          unique_prospects: new Set(rows.map((row) => `${row.prospect_id}:${row.day_key}`)).size,
          day_count: new Set(rows.map((row) => row.day_key)).size,
        },
        order: head.at as readonly (number | string)[],
      };
    });
  } else {
    const days = originDays(captures, () => "").map((day) => ({ ...day, source: day.head.source }));
    entries = groupBy(
      days.filter((day) => !filters.source || day.source === filters.source),
      (day) => `${day.source}:${day.origin_key}`,
    ).map((group) => {
      const head = first(group, (day) => [day.day_key, ...day.first_at]);
      return {
        row: {
          source: head.source,
          origin_key: head.origin_key,
          first_kind: head.head.origin_kind,
          first_value: head.head.origin_value,
          submission_count: group.reduce((sum, day) => sum + day.submissions, 0),
          unique_prospects: group.reduce((sum, day) => sum + day.unique_prospects, 0),
          day_count: group.length,
        },
        order: [head.day_key, ...head.first_at] as readonly (number | string)[],
      };
    });
  }
  return entries
    .sort((left, right) =>
      right.row.submission_count - left.row.submission_count || (before(left.order, right.order) ? -1 : 1),
    )
    .slice(0, filters.limit)
    .map((entry) => entry.row);
}

function topOriginsByTeamRows(
  model: Model,
  filters: Filters & { limitPerTeam: number; sortBy: "uniqueProspects" | "submissions" | null },
) {
  const captures = originCaptures(model).filter((row) => matches(row, filters));
  let origins;
  if (filters.workerId) {
    origins = groupBy(
      captures.filter((row) => row.active),
      (row) => `${row.team_id}:${row.source}:${row.origin_key}`,
    ).map((rows) => {
      const head = first(rows, (row) => row.at);
      return {
        team_id: head.team_id,
        source: head.source,
        origin_key: head.origin_key,
        first_kind: head.origin_kind,
        first_value: head.origin_value,
        submission_count: rows.length,
        unique_prospects: new Set(rows.map((row) => `${row.prospect_id}:${row.day_key}`)).size,
        day_count: new Set(rows.map((row) => row.day_key)).size,
      };
    });
  } else {
    const days = originDays(captures, (row) => `${row.team_id}:${row.source}`).filter((day) => day.submissions > 0);
    origins = groupBy(days, (day) => `${day.head.team_id}:${day.head.source}:${day.origin_key}`).map((group) => {
      const head = first(group, (day) => [day.day_key, ...day.first_at]);
      return {
        team_id: head.head.team_id,
        source: head.head.source,
        origin_key: head.origin_key,
        first_kind: head.head.origin_kind,
        first_value: head.head.origin_value,
        submission_count: group.reduce((sum, day) => sum + day.submissions, 0),
        unique_prospects: group.reduce((sum, day) => sum + day.unique_prospects, 0),
        day_count: group.length,
      };
    });
  }
  const rankKey = (row: (typeof origins)[number]) => [
    filters.sortBy === "submissions" ? row.submission_count : row.unique_prospects,
    row.unique_prospects,
    row.submission_count,
  ];
  return origins
    .map((row) => {
      const team = origins.filter((other) => other.team_id === row.team_id);
      return {
        ...row,
        team_unique_prospects: team.reduce((sum, other) => sum + other.unique_prospects, 0),
        team_submissions: team.reduce((sum, other) => sum + other.submission_count, 0),
        origin_rank: 1 + team.filter((other) => before(rankKey(row), rankKey(other))).length,
      };
    })
    .filter((row) => row.origin_rank <= filters.limitPerTeam);
}

function conversionRows(model: Model) {
  const people = new Map(model.people.filter((lead) => lead.status !== "merged").map((lead) => [lead._id, lead]));
  const stages = groupBy(
    model.prospects.filter(
      (prospect) => prospect.leadId && people.has(prospect.leadId) && prospect.firstCapturedAt >= FROM && prospect.firstCapturedAt < TO,
    ),
    (prospect) => prospect.firstCapturedByWorkerId,
  ).map((prospects) => {
    const row: Record<string, unknown> = { worker_id: prospects[0].firstCapturedByWorkerId, prospect: prospects.length };
    for (const stage of LIFECYCLE_STAGES.slice(1)) {
      row[stage] = prospects.filter((prospect) => {
        const at = (people.get(prospect.leadId!)!.lifecycleStageEnteredAt as Record<string, number | undefined>)[stage];
        return at !== undefined && at >= prospect.firstCapturedAt;
      }).length;
    }
    return row;
  });
  const deals = groupBy(
    model.attributions.filter(
      (row) => row.role === "lead_gen" && row.source.kind === "capture" && row.attributedAt >= FROM && row.attributedAt < TO,
    ),
    (row) => (row.source as { workerId: string }).workerId,
  ).map((rows) => ({ worker_id: (rows[0].source as { workerId: string }).workerId, deals: rows.length }));
  return { stages, deals };
}

function resparkRows(model: Model, source: Source | null) {
  const raw = groupBy(
    inRange(model).filter((row) => !source || row.source === source),
    (row) => row.worker_id,
  ).map((rows) => ({ worker_id: rows[0].worker_id, raw_leads: rows.filter((row) => row.active).length }));
  const booked = new Set(model.deals.filter((deal) => deal.firstBookedAt !== undefined).map((deal) => deal._id));
  return {
    raw,
    resparks: resparkResultRows(model, null),
    booked: groupBy(
      model.attributions.filter(
        (row) => row.source.kind === "respark" && row.attributedAt >= FROM && row.attributedAt < TO && booked.has(row.opportunityId),
      ),
      (row) => (row.source as { workerId: string }).workerId,
    ).map((rows) => ({ worker_id: (rows[0].source as { workerId: string }).workerId, booked: rows.length })),
  };
}

function resparkResultRows(model: Model, workerId: string | null) {
  return groupBy(
    model.resparkItems.filter(
      (item) => item.workedAt !== undefined && item.workedAt >= FROM && item.workedAt < TO && (!workerId || item.workerId === workerId),
    ),
    (item) => item.workerId,
  ).map((items) => ({
    worker_id: items[0].workerId,
    resparks: items.filter((item) => item.result === "resparked").length,
    not_a_fit: items.filter((item) => item.result === "not_a_fit").length,
  }));
}

// ---- Tests ----

const adminIdentity = { subject: "user_admin", org_id: "org_test" };
const noFilters = { teamId: null, workerId: null, source: null };

describe("Lead Gen from ClickHouse rows", () => {
  it("rebuilds the daily buckets the capture and void hooks keep", async () => {
    const { h, c } = await setup();
    const model = await loadModel(h);
    const buckets = await h.t.run(async (ctx) => await ctx.db.query("leadGenDailyStats").take(100));
    const inRangeBuckets = buckets
      .filter((row) => row.dayKey >= range.startDate && row.dayKey <= range.endDateInclusive)
      .map((row) => ({
        day_key: row.dayKey,
        worker_id: row.workerId,
        team_id: row.teamId ?? null,
        source: row.source,
        submissions: row.submissions,
        unique_prospects: row.uniqueProspectsSubmitted,
        duplicates: row.duplicateProspectSubmissions,
      }));
    expect(dailyRows(model, {})).toEqual(expect.arrayContaining(inRangeBuckets));
    expect(dailyRows(model, {})).toHaveLength(inRangeBuckets.length);
    // The voided capture's row stays, at zero, as the bucket row does.
    expect(dailyRows(model, { workerId: c.workerId, source: "meta_business" })).toEqual([
      expect.objectContaining({ submissions: 0, unique_prospects: 0, duplicates: 0 }),
    ]);
  });

  it("matches every Lead Gen reader with no filters", async () => {
    const { h } = await setup();
    const model = await loadModel(h);
    const base = { t: h.t, identity: adminIdentity, tenantId: h.tenantId, range };
    const daily = { daily: dailyRows(model, {}) };
    for (const [reportId, live] of [
      ["lead_gen.overview", api.leadGen.reporting.getOverview],
      ["lead_gen.workers", api.leadGen.reporting.listWorkerPerformance],
      ["lead_gen.teams", api.leadGen.reporting.listTeamPerformance],
      ["lead_gen.sources", api.leadGen.reporting.listSourcePerformance],
    ] as const) {
      await expectSameAnswer({ ...base, reportId, live, liveArgs: dayKeys, filters: noFilters, rows: daily });
    }
    await expectSameAnswer({
      ...base,
      reportId: "lead_gen.top_origins",
      live: api.leadGen.reporting.listTopOrigins,
      liveArgs: { ...dayKeys, limit: 2 },
      filters: { ...noFilters, limit: 2 },
      rows: { origins: topOriginRows(model, { limit: 2 }) },
    });
    const byTeam = await expectSameAnswer({
      ...base,
      reportId: "lead_gen.top_origins_by_team",
      live: api.leadGen.reporting.listTopOriginsByTeam,
      liveArgs: { ...dayKeys, limitPerTeam: 1, sortBy: "submissions" },
      filters: { ...noFilters, limitPerTeam: 1, sortBy: "submissions" },
      rows: { origins: topOriginsByTeamRows(model, { limitPerTeam: 1, sortBy: "submissions" }) },
    });
    expect(byTeam).toHaveLength(2);
    await expectSameAnswer({
      ...base,
      reportId: "lead_gen.prospect_conversions",
      live: api.leadGen.conversions.listProspectConversions,
      liveArgs: dayKeys,
      filters: {},
      rows: conversionRows(model),
    });
    const respark = await expectSameAnswer({
      ...base,
      reportId: "lead_gen.respark_performance",
      live: api.leadGen.resparkReports.listResparkPerformance,
      liveArgs: dayKeys,
      filters: { source: null },
      rows: resparkRows(model, null),
    });
    expect(respark.rows.some((row: { resparkedThenBooked: number }) => row.resparkedThenBooked === 1)).toBe(true);
  });

  it("applies the team, worker and source filters the same way", async () => {
    const { h, a, teamA } = await setup();
    const model = await loadModel(h);
    const base = { t: h.t, identity: adminIdentity, tenantId: h.tenantId, range };
    for (const filters of [
      { ...noFilters, source: "instagram" as const },
      { ...noFilters, teamId: teamA },
      { ...noFilters, workerId: a.workerId, source: "instagram" as const },
    ]) {
      const liveFilters = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== null));
      await expectSameAnswer({
        ...base,
        reportId: "lead_gen.workers",
        live: api.leadGen.reporting.listWorkerPerformance,
        liveArgs: { ...dayKeys, ...liveFilters },
        filters,
        rows: { daily: dailyRows(model, filters) },
      });
      await expectSameAnswer({
        ...base,
        reportId: "lead_gen.sources",
        live: api.leadGen.reporting.listSourcePerformance,
        liveArgs: { ...dayKeys, ...liveFilters },
        filters,
        rows: { daily: dailyRows(model, filters) },
      });
      await expectSameAnswer({
        ...base,
        reportId: "lead_gen.top_origins",
        live: api.leadGen.reporting.listTopOrigins,
        liveArgs: { ...dayKeys, ...liveFilters, limit: 25 },
        filters: { ...filters, limit: 25 },
        rows: { origins: topOriginRows(model, { ...filters, limit: 25 }) },
      });
      await expectSameAnswer({
        ...base,
        reportId: "lead_gen.top_origins_by_team",
        live: api.leadGen.reporting.listTopOriginsByTeam,
        liveArgs: { ...dayKeys, ...liveFilters },
        filters: { ...filters, limitPerTeam: 10, sortBy: null },
        rows: { origins: topOriginsByTeamRows(model, { ...filters, limitPerTeam: 10, sortBy: null }) },
      });
    }
    await expectSameAnswer({
      ...base,
      reportId: "lead_gen.respark_performance",
      live: api.leadGen.resparkReports.listResparkPerformance,
      liveArgs: { ...dayKeys, source: "meta_business" },
      filters: { source: "meta_business" },
      rows: resparkRows(model, "meta_business"),
    });
  });

  it("matches My Activity for the caller's own worker", async () => {
    const { h, a, c } = await setup();
    const model = await loadModel(h);
    for (const worker of [a, c]) {
      const summary = await expectSameAnswer({
        t: h.t,
        identity: worker.identity,
        tenantId: h.tenantId,
        range,
        reportId: "my_activity.summary",
        live: api.leadGen.activity.getMyActivitySummary,
        liveArgs: {
          range: { kind: "custom", startBusinessDate: range.startDate, endBusinessDateInclusive: range.endDateInclusive },
        },
        filters: { workerId: worker.workerId },
        rows: {
          daily: dailyRows(model, { workerId: worker.workerId }),
          resparks: resparkResultRows(model, worker.workerId),
        },
      });
      if (worker === a) expect(summary).toMatchObject({ resparks: 1, notAFit: 1, scheduledHours: 6 });
    }
  });
});
