import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness } from "../../tests/bookingHarness";
import { migrations } from "../migrations";

// Captures recorded with no team take the specialist's current team, with
// their daily stats and team-origin stats (convex/leadGen/backfills.ts).

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const NOW = Date.parse("2026-08-12T15:00:00Z");
const DAY_KEY = "2026-08-12";

async function run(h: Harness, name: string) {
  await h.t.mutation(internal.migrations.run, { fn: `migrations:${name}` });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [status] = await h.t.run((ctx) =>
    migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
  );
  return status;
}

async function capture(h: Harness, handle: string) {
  await h.admin.mutation(api.leadGen.capture.submit, {
    source: "instagram",
    rawHandleOrProfileUrl: `@${handle}`,
    originKind: "post",
    originUrlOrLabel: "https://www.instagram.com/p/ABC123/",
  });
}

async function state(h: Harness) {
  return await h.t.run(async (ctx) => ({
    submissions: await ctx.db.query("leadGenSubmissions").take(20),
    daily: await ctx.db.query("leadGenDailyStats").take(20),
    teamOrigin: await ctx.db.query("leadGenTeamOriginStats").take(20),
  }));
}

it("gives no-team captures, their daily stats and team-origin stats the specialist's current team", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const h = await bookingHarness();
  migrationsTest.register(h.t);

  // Captured while the specialist had no team.
  await capture(h, "no.team.one");
  await capture(h, "no.team.two");
  const before = await state(h);
  expect(before.submissions.map((row) => row.teamId)).toEqual([undefined, undefined]);
  expect(before.daily.map((row) => row.teamId)).toEqual([undefined]);
  expect(before.teamOrigin.every((row) => row.teamId === undefined)).toBe(true);

  // Then they joined a team, and captured once more that day.
  const teamId: Id<"attributionTeams"> = await h.t.run(async (ctx) => {
    const id = await ctx.db.insert("attributionTeams", {
      tenantId: h.tenantId, slug: "team", displayName: "Team", utmSource: "team",
      normalizedUtmSource: "team", isActive: true, createdAt: 0, updatedAt: 0,
    } as never);
    const worker = (await ctx.db.query("leadGenWorkers").first())!;
    await ctx.db.patch("leadGenWorkers", worker._id, { teamId: id });
    return id;
  });
  await capture(h, "with.team");
  const mid = await state(h);
  expect(mid.daily.map((row) => row.teamId ?? null).sort()).toEqual([null, teamId].sort());

  expect((await run(h, "assertCaptureTeams"))?.error).toContain("has no team");
  expect((await run(h, "backfillCaptureTeams"))?.isDone).toBe(true);
  expect((await run(h, "backfillDailyStatTeams"))?.isDone).toBe(true);
  await h.t.mutation(internal.migrations.run, { fn: "migrations:assertCaptureTeams", reset: true });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [captureAssert] = await h.t.run((ctx) =>
    migrations.getStatus(ctx, { migrations: ["migrations:assertCaptureTeams"] as never }),
  );
  expect(captureAssert?.error).toBeUndefined();
  expect((await run(h, "assertDailyStatTeams"))?.error).toBeUndefined();
  const preview = await h.t.mutation(internal.leadGen.backfills.rebuildTeamOriginStatsDay, {
    tenantId: h.tenantId, dayKey: DAY_KEY, dryRun: true,
  });
  expect(preview).toMatchObject({ existingWithoutTeam: 1, rebuiltWithoutTeam: 0, submissions: 3 });
  // Only the team moves: the day's totals are the same.
  expect(preview.after).toEqual(preview.before);
  await h.t.mutation(internal.leadGen.backfills.rebuildTeamOriginStatsDay, {
    tenantId: h.tenantId, dayKey: DAY_KEY, dryRun: false,
  });

  const after = await state(h);
  expect(after.submissions.map((row) => row.teamId)).toEqual([teamId, teamId, teamId]);
  // The no-team row merged into the team's row for the same day and source.
  expect(after.daily).toHaveLength(1);
  expect(after.daily[0]).toMatchObject({ teamId, submissions: 3, uniqueProspectsSubmitted: 3 });
  expect(after.teamOrigin).toHaveLength(1);
  expect(after.teamOrigin[0]).toMatchObject({ teamId, submissions: 3, uniqueProspectsSubmitted: 3 });

  // Rerunning changes nothing.
  await h.t.mutation(internal.migrations.run, { fn: "migrations:backfillCaptureTeams", reset: true });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await state(h)).submissions.map((row) => row.teamId)).toEqual([teamId, teamId, teamId]);
});

it("leaves the captures of a specialist with no team as they are", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const h = await bookingHarness();
  migrationsTest.register(h.t);
  await capture(h, "still.no.team");
  expect((await run(h, "backfillCaptureTeams"))?.isDone).toBe(true);
  expect((await run(h, "backfillDailyStatTeams"))?.isDone).toBe(true);
  const after = await state(h);
  expect(after.submissions[0].teamId).toBeUndefined();
  expect(after.daily[0].teamId).toBeUndefined();
});

it("refuses to repair a day while a business-day rebuild runs", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const h = await bookingHarness();
  await h.t.run((ctx) =>
    ctx.db.insert("businessDayRebuilds", {
      tenantId: h.tenantId, version: 1, rebuildLeadGen: true, requestedAt: NOW, state: "running",
      phase: "meetings", cursor: null, pass: 1, sourceRevision: 0, computedRevision: 0,
      meetingsEnqueued: 0, leadGenRowsComputed: 0, leadGenRowsSwapped: 0, leadGenAudited: 0,
      meetingsAsserted: 0, bucketsAsserted: 0, sourcesAsserted: 0, leadGenDone: false,
    } as never),
  );
  await expect(
    h.t.mutation(internal.leadGen.backfills.rebuildTeamOriginStatsDay, { tenantId: h.tenantId, dayKey: DAY_KEY, dryRun: true }),
  ).rejects.toThrow("business-day rebuild is running");
});

