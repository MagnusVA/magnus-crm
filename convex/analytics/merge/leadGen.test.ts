import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { recordDealCreation } from "../../lib/attribution/dealAttributions";
import { bookingHarness, testLeadGenTeam } from "../../../tests/bookingHarness";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import {
  mergeLeadGenOverview,
  mergeLeadGenWorkers,
  mergeLeadGenTopOriginsByTeam,
  mergeLeadGenProspectConversions,
  mergeLeadGenResparkPerformance,
  mergeMyActivitySummary,
} from "./leadGen";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FROM = Date.UTC(2026, 9, 19, 7);
const TO = Date.UTC(2026, 9, 21, 7);
const POST_X = "https://www.instagram.com/p/PostX/";
const REEL_Y = "https://www.instagram.com/reel/ReelY/";
const POST_Z = "https://www.instagram.com/p/PostZ/";
const windows = {
  history: { startDayKey: "2026-10-19", endDayKey: "2026-10-19" },
  today: { startDayKey: "2026-10-20", endDayKey: "2026-10-20" },
  whole: { startDayKey: "2026-10-19", endDayKey: "2026-10-20" },
};
const adminIdentity = { subject: "user_admin", org_id: "org_test" };

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
    return {
      teamA: await testLeadGenTeam(ctx, h.tenantId),
      teamB: await testLeadGenTeam(ctx, h.tenantId, "team-b"),
    };
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
  await h.t.run((ctx) =>
    ctx.db.insert("leadGenWorkerSchedules", {
      tenantId: h.tenantId,
      workerId: a.workerId,
      userId: a.userId,
      updatedByUserId: a.userId,
      weekday: "tuesday",
      scheduledHours: 3,
      updatedAt: 0,
    }),
  );
  const admin = { subject: "user_admin", org_id: "org_test" };

  // The Respark pool: people captured long before the range.
  for (let i = 0; i < 4; i++) await capture(h, admin, `pool.${i}`, FROM - (45 + i) * DAY);
  // A capture before the range makes p2's later captures duplicates.
  await capture(h, a.identity, "p2", FROM - 2 * HOUR);

  // Day 1. p1's first capture (a) is voided below, so b's earns the credit.
  const voided = await capture(h, a.identity, "p1", FROM + 10 * MINUTE, {
    kind: "post",
    url: POST_X,
  });
  await capture(h, b.identity, "p1", FROM + 20 * MINUTE, { kind: "post", url: POST_X });
  await capture(h, b.identity, "p2", FROM + 30 * MINUTE, { kind: "reel", url: REEL_Y });
  await capture(h, a.identity, "p3", FROM + 40 * MINUTE, { kind: "post", url: POST_X });
  await capture(h, a.identity, "p3", FROM + 50 * MINUTE, undefined, "meta_business");
  await capture(h, c.identity, "p4", FROM + 60 * MINUTE, { kind: "reel", url: REEL_Y });
  // c's only Meta Business capture of the day is voided: its row stays at zero.
  const voidedAlone = await capture(
    h,
    c.identity,
    "p5",
    FROM + 70 * MINUTE,
    undefined,
    "meta_business",
  );
  // Day 2.
  await capture(h, a.identity, "p1", FROM + DAY + 10 * MINUTE, { kind: "post", url: POST_Z });
  await capture(h, b.identity, "p6", FROM + DAY + 20 * MINUTE, { kind: "post", url: POST_Z });
  await capture(h, c.identity, "p6", FROM + DAY + 30 * MINUTE, { kind: "post", url: POST_Z });
  await capture(h, a.identity, "meta.today", FROM + DAY + 50 * MINUTE, undefined, "meta_business");
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
  await work(h, a.identity, FROM + DAY + 4 * HOUR, "not_a_fit");
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
  await work(h, a.identity, FROM + DAY + 5 * HOUR, "resparked");
  vi.setSystemTime(TO + 2 * HOUR);
  return { h, a, b, c, teamA, teamB };
}

describe("Lead Gen across the split", () => {
  it("merges overview and worker totals with team, worker and source filters", async () => {
    const { h, a, teamA } = await setup();
    for (const filters of [
      {},
      { teamId: teamA },
      { workerId: a.workerId },
      { source: "instagram" as const },
      { workerId: a.workerId, source: "meta_business" as const },
    ]) {
      const args = {
        history: { ...windows.history, ...filters },
        today: { ...windows.today, ...filters },
        whole: { ...windows.whole, ...filters },
      };
      const overview = await expectMergedAnswer({
        t: h.t,
        identity: adminIdentity,
        live: api.leadGen.reporting.getOverview,
        ...args,
        merge: mergeLeadGenOverview,
      });
      expect(overview.history.submissions).toBeGreaterThan(0);
      expect(overview.today.submissions).toBeGreaterThan(0);
      const workers = await expectMergedAnswer({
        t: h.t,
        identity: adminIdentity,
        live: api.leadGen.reporting.listWorkerPerformance,
        ...args,
        merge: mergeLeadGenWorkers,
      });
      expect(workers.history.some((row) => row.submissions > 0)).toBe(true);
      expect(workers.today.some((row) => row.submissions > 0)).toBe(true);
    }
  });

  it("keeps tied worker rows exact apart from their unspecified tie order", async () => {
    const { h, a } = await setup();
    await capture(h, a.identity, "p3", FROM + DAY + 55 * MINUTE, { kind: "post", url: POST_X });
    const reader = h.t.withIdentity(adminIdentity);
    const history = await reader.query(api.leadGen.reporting.listWorkerPerformance, {
      ...windows.history,
      source: "instagram",
    });
    const today = await reader.query(api.leadGen.reporting.listWorkerPerformance, {
      ...windows.today,
      source: "instagram",
    });
    const whole = await reader.query(api.leadGen.reporting.listWorkerPerformance, {
      ...windows.whole,
      source: "instagram",
    });
    const merged = mergeLeadGenWorkers(history, today);
    const byId = (rows: typeof whole) =>
      [...rows].sort((left, right) => left.workerId.localeCompare(right.workerId));
    expect(byId(merged)).toEqual(byId(whole));
    expect(merged.map((row) => row.submissions)).toEqual(whole.map((row) => row.submissions));
    expect(whole[0].submissions).toBe(whole[1].submissions);
  });

  it("merges origin candidates and keeps exact team totals under page filters", async () => {
    const { h, a, teamA } = await setup();
    await capture(h, a.identity, "p3", FROM + DAY + 55 * MINUTE, { kind: "post", url: POST_X });
    for (const filters of [
      {},
      { teamId: teamA },
      { workerId: a.workerId },
      { source: "instagram" as const },
    ]) {
      const args = (window: typeof windows.history) => ({
        ...window,
        ...filters,
        limitPerTeam: 10,
        sortBy: "submissions" as const,
      });
      const answers = await expectMergedAnswer({
        t: h.t,
        identity: adminIdentity,
        live: api.leadGen.reporting.listTopOriginsByTeam,
        history: args(windows.history),
        today: args(windows.today),
        whole: args(windows.whole),
        merge: mergeLeadGenTopOriginsByTeam,
      });
      expect(answers.history.length).toBeGreaterThan(0);
      expect(answers.today.length).toBeGreaterThan(0);
    }
  });

  it("re-ranks the available top ten candidates when a half omitted an origin", async () => {
    const { h, teamA } = await setup();
    const d = await worker(h, "origin_worker", teamA);
    for (let index = 0; index < 10; index += 1) {
      for (let count = 0; count < 2; count += 1) {
        await capture(
          h,
          d.identity,
          `rank.${index}.${count}`,
          FROM + HOUR + index * MINUTE + count,
          { kind: "post", url: `https://www.instagram.com/p/Rank${index}/` },
        );
      }
    }
    const common = "https://www.instagram.com/p/Common/";
    await capture(h, d.identity, "common.history", FROM + 2 * HOUR, { kind: "post", url: common });
    for (let index = 0; index < 3; index += 1) {
      await capture(h, d.identity, `common.today.${index}`, FROM + DAY + HOUR + index * MINUTE, {
        kind: "post",
        url: common,
      });
    }
    const reader = h.t.withIdentity(adminIdentity);
    const read = (window: typeof windows.history) =>
      reader.query(api.leadGen.reporting.listTopOriginsByTeam, {
        ...window,
        workerId: d.workerId,
        limitPerTeam: 10,
        sortBy: "submissions",
      });
    const history = await read(windows.history);
    const today = await read(windows.today);
    const whole = await read(windows.whole);
    const merged = mergeLeadGenTopOriginsByTeam(history, today);
    const totals = (teams: typeof whole) => teams.map(({ origins: _origins, ...team }) => team);
    expect(totals(merged)).toEqual(totals(whole));
    expect(history[0].origins).toHaveLength(10);
    expect(today[0].origins).toHaveLength(1);
    const candidates = new Map<string, (typeof today)[number]["origins"][number]>();
    for (const origin of [...history[0].origins, ...today[0].origins]) {
      const key = `${origin.source}:${origin.originKey}`;
      const previous = candidates.get(key);
      candidates.set(key, {
        ...origin,
        submissions: (previous?.submissions ?? 0) + origin.submissions,
        uniqueProspects: (previous?.uniqueProspects ?? 0) + origin.uniqueProspects,
        dayCount: (previous?.dayCount ?? 0) + origin.dayCount,
      });
    }
    const expected = [...candidates.values()]
      .sort(
        (left, right) =>
          right.submissions - left.submissions ||
          right.uniqueProspects - left.uniqueProspects ||
          left.originValue.localeCompare(right.originValue),
      )
      .slice(0, 10);
    expect(merged[0].origins).toEqual(expected);
    expect(merged[0].origins[0].submissions).toBe(3);
    expect(whole[0].origins[0].submissions).toBe(4);
  });

  it("adds prospect cohorts and attributed deals", async () => {
    const { h, a } = await setup();
    // The fixture's first captures are on both sides of the split.
    const answers = await expectMergedAnswer({
      t: h.t,
      identity: adminIdentity,
      live: api.leadGen.conversions.listProspectConversions,
      ...windows,
      merge: mergeLeadGenProspectConversions,
    });
    expect(answers.history.rows.reduce((sum, row) => sum + row.counts.prospect, 0)).toBeGreaterThan(
      0,
    );
    expect(answers.today.rows.reduce((sum, row) => sum + row.counts.prospect, 0)).toBeGreaterThan(
      0,
    );
    expect(answers.whole.rows.some((row) => row.deals > 0)).toBe(true);
    expect(answers.whole.rows.some((row) => row.workerId === a.workerId)).toBe(true);
  });

  it("merges Respark results for current workers and the source filter", async () => {
    const { h } = await setup();
    for (const filters of [{}, { source: "meta_business" as const }]) {
      const answers = await expectMergedAnswer({
        t: h.t,
        identity: adminIdentity,
        live: api.leadGen.resparkReports.listResparkPerformance,
        history: { ...windows.history, ...filters },
        today: { ...windows.today, ...filters },
        whole: { ...windows.whole, ...filters },
        merge: mergeLeadGenResparkPerformance,
      });
      expect(answers.history.rows.some((row) => row.resparks > 0)).toBe(true);
      expect(answers.today.rows.some((row) => row.resparks > 0)).toBe(true);
      expect(
        mergeLeadGenResparkPerformance(
          { ...answers.history, rawLeadsCapped: true, capped: true, bookedCapped: true },
          answers.today,
        ),
      ).toMatchObject({ rawLeadsCapped: true, capped: true, bookedCapped: true });
    }
  });

  it("merges My Activity for the worker from auth, including range labels", async () => {
    const { h, a, c } = await setup();
    const args = (window: typeof windows.history) => ({
      range: {
        kind: "custom" as const,
        startBusinessDate: window.startDayKey,
        endBusinessDateInclusive: window.endDayKey,
      },
    });
    for (const worker of [a, c]) {
      const answers = await expectMergedAnswer({
        t: h.t,
        identity: worker.identity,
        live: api.leadGen.activity.getMyActivitySummary,
        history: args(windows.history),
        today: args(windows.today),
        whole: args(windows.whole),
        merge: mergeMyActivitySummary,
      });
      expect(answers.history.submissions).toBeGreaterThan(0);
      expect(answers.today.submissions).toBeGreaterThan(0);
    }
  });
});
