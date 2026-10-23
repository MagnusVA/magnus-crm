import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import { DAY, MONTH, NOW, pipelineHealthFixture } from "../../tests/pipelineHealthAggregateFixtures";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import { insertLatestMeeting } from "../../tests/dealStageFixtures";
import { patchOpportunityLifecycle, transitionOpportunity } from "../lib/opportunityActivity";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { deleteOpportunityAggregate } from "./writeHooks";
import { openDealAging, personLosses } from "./pipelineHealthAggregates";

const verification = internal.reporting.pipelineHealthVerification;
const migrationNames = [
  "backfillOpenDealAging",
  "backfillPersonLosses",
  "assertPipelineHealthAggregates",
] as const;
type Harness = Awaited<ReturnType<typeof pipelineHealthFixture>>;
type MigrationName = typeof migrationNames[number];

async function runMigration(h: Harness, name: MigrationName, reset = false, batchSize = 200) {
  await h.t.mutation(internal.migrations.run, { fn: `migrations:${name}`, reset, batchSize });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [status] = await h.t.run((ctx) =>
    ctx.runQuery(components.migrations.lib.getStatus, { names: [`migrations:${name}`] }));
  return status;
}

async function completeMigrations(h: Harness) {
  for (const name of migrationNames) {
    expect(await runMigration(h, name)).toMatchObject({ isDone: true, state: "success" });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Pipeline Health aggregates", () => {
  it("tracks stage moves, person/system loss corrections, reopen and delete", async () => {
    const h = await pipelineHealthFixture();
    const id = await h.deal();
    const counts = () => h.t.run(async (ctx) => ({
      open: await openDealAging.count(ctx, { namespace: h.tenantId }),
      booked: await openDealAging.count(ctx, { namespace: h.tenantId, bounds: { prefix: ["booked"] } }),
      losses: await personLosses.count(ctx, { namespace: h.tenantId }),
    }));
    expect(await counts()).toEqual({ open: 1, booked: 1, losses: 0 });
    await h.t.run((ctx) => transitionOpportunity(ctx, id, { to: { stage: "follow_up" }, source: "closer" }));
    expect(await counts()).toEqual({ open: 1, booked: 0, losses: 0 });
    await h.t.run((ctx) => transitionOpportunity(ctx, id, {
      to: { stage: "closed", outcome: "lost" }, source: "closer",
      fields: { lostAt: MONTH.startDate, lostByUserId: h.actorId, lostReason: "Budget" },
    }));
    expect(await counts()).toEqual({ open: 0, booked: 0, losses: 1 });
    await h.t.run((ctx) => patchOpportunityLifecycle(ctx, id, {
      lostAt: MONTH.startDate + DAY, lostByUserId: undefined, lostReason: "Budget",
    }));
    expect(await h.t.run(async (ctx) => (await personLosses.paginate(ctx, { namespace: h.tenantId })).page.map((entry) => entry.key)))
      .toEqual([[MONTH.startDate + DAY, ""]]);
    await h.t.run((ctx) => patchOpportunityLifecycle(ctx, id, { lostReason: "no_show" }));
    expect(await counts()).toEqual({ open: 0, booked: 0, losses: 0 });
    await h.t.run((ctx) => patchOpportunityLifecycle(ctx, id, { lostByUserId: h.actorId }));
    expect((await counts()).losses).toBe(1); // A named person overrides a system reason.
    await h.t.run((ctx) => patchOpportunityLifecycle(ctx, id, { lostByUserId: undefined }));
    await h.t.run((ctx) => transitionOpportunity(ctx, id, { to: { stage: "booked" }, source: "system", exception: "no_show_withdrawn" }));
    expect(await counts()).toEqual({ open: 1, booked: 1, losses: 0 });
    await h.t.run((ctx) => forceOpportunityState(ctx, id, { stage: "closed", outcome: "lost", lostAt: NOW, lostByUserId: h.actorId }));
    expect((await counts()).losses).toBe(1);
    await h.t.run(async (ctx) => {
      await deleteOpportunityAggregate(ctx, (await ctx.db.get("opportunities", id))!);
      await ctx.db.delete("opportunities", id);
    });
    expect(await counts()).toEqual({ open: 0, booked: 0, losses: 0 });
    const openId = await h.deal();
    await h.t.run(async (ctx) => {
      await deleteOpportunityAggregate(ctx, (await ctx.db.get("opportunities", openId))!);
      await ctx.db.delete("opportunities", openId);
    });
    expect(await counts()).toEqual({ open: 0, booked: 0, losses: 0 });
  });

  it("rekeys only aging when meeting refs add, change, or remove nextMeetingAt", async () => {
    const h = await pipelineHealthFixture();
    const id = await h.deal();
    const meetingId = await h.t.run((ctx) => insertLatestMeeting(ctx, id, { status: "scheduled", scheduledAt: NOW + DAY }));
    const keys = () => h.t.run(async (ctx) => (await openDealAging.paginate(ctx, { namespace: h.tenantId })).page.map((entry) => entry.key));
    await h.t.run((ctx) => updateOpportunityMeetingRefs(ctx, id));
    expect(await keys()).toEqual([["booked", NOW + DAY]]);
    await h.t.run(async (ctx) => {
      await ctx.db.patch("meetings", meetingId, { scheduledAt: NOW + 2 * DAY });
      await updateOpportunityMeetingRefs(ctx, id);
    });
    expect(await keys()).toEqual([["booked", NOW + 2 * DAY]]);
    await h.t.run(async (ctx) => {
      await ctx.db.patch("meetings", meetingId, { status: "canceled" });
      await updateOpportunityMeetingRefs(ctx, id);
      await updateOpportunityMeetingRefs(ctx, id);
    });
    expect(await keys()).toEqual([["booked", 0]]);
    await h.t.run((ctx) => patchOpportunityLifecycle(ctx, id, { createdAt: NOW - DAY, nextMeetingAt: NOW + DAY }));
    expect(await keys()).toEqual([["booked", NOW + DAY]]);
    expect(await h.t.run((ctx) => openDealAging.sum(ctx, { namespace: h.tenantId }))).toBe(NOW - DAY);
  });

  it("backfills every page idempotently, excluding system losses and losses without time", async () => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    await h.deal();
    await h.deal();
    await h.deal("lost", { lostAt: NOW, lostByUserId: h.actorId });
    await h.deal("no_show", { lostAt: NOW, lostReason: "no_show" });
    await h.deal("lost", { lostReason: "Budget" });
    await h.t.run(async (ctx) => {
      await openDealAging.clear(ctx, { namespace: h.tenantId });
      await personLosses.clear(ctx, { namespace: h.tenantId });
    });
    for (let run = 0; run < 2; run++) {
      for (const name of migrationNames) {
        expect(await runMigration(h, name, true, 2)).toMatchObject({ isDone: true, processed: 5, state: "success" });
      }
      expect(await h.t.run((ctx) => openDealAging.count(ctx, { namespace: h.tenantId }))).toBe(2);
      expect(await h.t.run((ctx) => personLosses.count(ctx, { namespace: h.tenantId }))).toBe(1);
    }
    expect(await h.t.query(verification.verifyPipelineHealthAggregateTotals, { tenantId: h.tenantId })).toEqual([]);
  });

  it.each(["openDealAging", "personLosses"] as const)("assert catches a missing %s ID even when another deal shares its key", async (name) => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    const status = name === "openDealAging" ? "scheduled" : "lost";
    const fields = { lostAt: NOW, lostByUserId: h.actorId };
    const id = await h.deal(status, fields);
    await h.deal(status, fields);
    const aggregate = name === "openDealAging" ? openDealAging : personLosses;
    await h.t.run(async (ctx) => {
      await aggregate.delete(ctx, (await ctx.db.get("opportunities", id))!);
    });
    const result = await runMigration(h, "assertPipelineHealthAggregates");
    expect(result).toMatchObject({ isDone: false, state: "failed" });
    expect(result.error).toContain(`${name} mismatch: ${id}`);
  });

  it.each(["openDealAging", "personLosses"] as const)("assert catches a %s entry stored at the wrong key", async (name) => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    const id = await h.deal(name === "openDealAging" ? "scheduled" : "lost", { lostAt: NOW, lostByUserId: h.actorId });
    await h.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", id))!;
      if (name === "openDealAging") {
        await openDealAging.replace(ctx, deal, { ...deal, nextMeetingAt: NOW });
      } else {
        await personLosses.replace(ctx, deal, { ...deal, lostByUserId: undefined });
      }
    });
    const result = await runMigration(h, "assertPipelineHealthAggregates");
    expect(result).toMatchObject({ isDone: false, state: "failed" });
    expect(result.error).toContain(`${name} mismatch: ${id}`);
  });

  it("assert catches an aging entry with the correct key and ID but wrong sumValue", async () => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    const id = await h.deal();
    await h.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", id))!;
      await openDealAging.replace(ctx, deal, { ...deal, createdAt: deal.createdAt + DAY });
    });
    const result = await runMigration(h, "assertPipelineHealthAggregates");
    expect(result).toMatchObject({ isDone: false, state: "failed" });
    expect(result.error).toContain(`openDealAging sum mismatch: ${id}`);
  });

  it("totals catches an extra aging entry under a closed stage", async () => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    const id = await h.deal();
    await completeMigrations(h);
    await h.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", id))!;
      await openDealAging.insert(ctx, { ...deal, stage: "closed", outcome: "lost" });
    });
    const args = { tenantId: h.tenantId };
    expect(await h.t.query(verification.verifyPipelineHealthAggregateTotals, args)).toEqual([
      { scope: "openDealAging", metric: "count", source: 1, aggregate: 2 },
    ]);
    await expect(h.t.mutation(verification.markPipelineHealthAggregatesVerified, args)).rejects.toThrow("mismatch");
    expect((await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))!.pipelineHealthAggregatesVerifiedAt).toBeUndefined();
  });

  it("totals catches an extra open entry and mark rechecks it after the assert passes", async () => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    const id = await h.deal();
    await completeMigrations(h);
    await h.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", id))!;
      await openDealAging.insert(ctx, { ...deal, nextMeetingAt: NOW });
    });
    const args = { tenantId: h.tenantId };
    expect(await h.t.query(verification.verifyPipelineHealthAggregateTotals, args)).toEqual([
      { scope: "booked", metric: "count", source: 1, aggregate: 2 },
      { scope: "openDealAging", metric: "count", source: 1, aggregate: 2 },
    ]);
    await expect(h.t.mutation(verification.markPipelineHealthAggregatesVerified, args)).rejects.toThrow("mismatch");
    expect((await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))!.pipelineHealthAggregatesVerifiedAt).toBeUndefined();
  });

  it.each(["deleted", "system", "wrong date", "wrong actor", "duplicate", "other tenant"] as const)("totals catches a %s person-loss entry across all dates", async (corruption) => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    // Earlier than the old verifier's first month, so the reverse check
    // must cover the whole tenant rather than a caller-selected range.
    const id = await h.deal("lost", { lostAt: 1, lostByUserId: h.actorId });
    await completeMigrations(h);
    await h.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", id))!;
      switch (corruption) {
        case "deleted":
          await ctx.db.delete("opportunities", id);
          break;
        case "system":
          // Deliberately bypass hooks to leave an ineligible entry behind.
          await ctx.db.patch("opportunities", id, { lostByUserId: undefined, lostReason: "no_show" });
          break;
        case "wrong date":
          await personLosses.replace(ctx, deal, { ...deal, lostAt: 2 });
          break;
        case "wrong actor":
          await personLosses.replace(ctx, deal, { ...deal, lostByUserId: undefined });
          break;
        case "duplicate":
          await personLosses.insert(ctx, { ...deal, lostAt: 2 });
          break;
        case "other tenant": {
          const tenantId = await ctx.db.insert("tenants", {
            companyName: "Other", contactEmail: "other@example.com", workosOrgId: "org_other",
            status: "active", inviteExpiresAt: 0, createdBy: "test",
          });
          await ctx.db.patch("opportunities", id, { tenantId });
          break;
        }
      }
    });
    const args = { tenantId: h.tenantId };
    expect(await h.t.query(verification.verifyPipelineHealthAggregateTotals, args)).toEqual([
      { scope: id, metric: "entry", source: 1, aggregate: 0 },
    ]);
    await expect(h.t.mutation(verification.markPipelineHealthAggregatesVerified, args)).rejects.toThrow("mismatch");
    expect((await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))!.pipelineHealthAggregatesVerifiedAt).toBeUndefined();
  });

  it("refuses more than 2,000 person losses before fetching any deals", async () => {
    const h = await pipelineHealthFixture();
    vi.spyOn(personLosses, "count").mockResolvedValue(2_001);
    const iterate = vi.spyOn(personLosses, "iter");
    expect(await h.t.query(verification.verifyPipelineHealthAggregateTotals, { tenantId: h.tenantId })).toEqual([
      { scope: "personLosses.limit", metric: "count", source: 2_000, aggregate: 2_001 },
    ]);
    expect(iterate).not.toHaveBeenCalled();
  });

  it.each(migrationNames)("mark refuses when %s has not run", async (missing) => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    await h.deal();
    for (const name of migrationNames) {
      if (name !== missing) await runMigration(h, name);
    }
    const args = { tenantId: h.tenantId };
    expect(await h.t.query(verification.verifyPipelineHealthAggregateTotals, args)).toEqual([]);
    await expect(h.t.mutation(verification.markPipelineHealthAggregatesVerified, args))
      .rejects.toThrow(`migration incomplete: migrations:${missing}`);
    expect((await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))!.pipelineHealthAggregatesVerifiedAt).toBeUndefined();
  });

  it.each(["backfillOpenDealAging", "backfillPersonLosses"] as const)("mark refuses a stale assert after resetting %s until the assert is reset too", async (name) => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    await h.deal();
    await completeMigrations(h);
    vi.setSystemTime(NOW + 1_000);
    const backfill = await runMigration(h, name, true);
    expect(backfill).toMatchObject({ isDone: true, state: "success" });
    const args = { tenantId: h.tenantId };
    expect(await h.t.query(verification.verifyPipelineHealthAggregateTotals, args)).toEqual([]);
    await expect(h.t.mutation(verification.markPipelineHealthAggregatesVerified, args))
      .rejects.toThrow("assert predates backfill");
    // A completed assert is skipped unless reset is explicit.
    const skipped = await runMigration(h, "assertPipelineHealthAggregates");
    expect(skipped.latestStart).toBeLessThan(backfill.latestEnd!);
    await expect(h.t.mutation(verification.markPipelineHealthAggregatesVerified, args))
      .rejects.toThrow("assert predates backfill");
    expect((await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))!.pipelineHealthAggregatesVerifiedAt).toBeUndefined();
    const rerun = await runMigration(h, "assertPipelineHealthAggregates", true);
    expect(rerun).toMatchObject({ isDone: true, state: "success" });
    expect(rerun.latestStart).toBeGreaterThanOrEqual(backfill.latestEnd!);
    await h.t.mutation(verification.markPipelineHealthAggregatesVerified, args);
    expect((await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))!.pipelineHealthAggregatesVerifiedAt).toBe(NOW + 1_000);
  });

  it.each(["backfillOpenDealAging", "backfillPersonLosses"] as const)("mark refuses an assert that starts before %s finishes", async (name) => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    await h.deal();
    await h.deal("lost", { lostAt: NOW, lostByUserId: h.actorId });
    const other = name === "backfillOpenDealAging" ? "backfillPersonLosses" : "backfillOpenDealAging";
    await runMigration(h, other);
    await h.t.mutation(internal.migrations.run, { fn: `migrations:${name}`, batchSize: 1 });
    vi.setSystemTime(NOW + 1_000);
    await h.t.mutation(internal.migrations.run, { fn: "migrations:assertPipelineHealthAggregates", batchSize: 1 });
    vi.setSystemTime(NOW + 2_000);
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    const statuses = await h.t.run((ctx) => ctx.runQuery(components.migrations.lib.getStatus, {
      names: [`migrations:${name}`, "migrations:assertPipelineHealthAggregates"],
    }));
    const backfill = statuses.find((status) => status.name === `migrations:${name}`)!;
    const assertion = statuses.find((status) => status.name === "migrations:assertPipelineHealthAggregates")!;
    expect(backfill).toMatchObject({ isDone: true, state: "success" });
    expect(assertion).toMatchObject({ isDone: true, state: "success" });
    expect(assertion.latestStart).toBeLessThan(backfill.latestEnd!);
    expect(assertion.latestEnd).toBeGreaterThanOrEqual(backfill.latestEnd!);
    const args = { tenantId: h.tenantId };
    expect(await h.t.query(verification.verifyPipelineHealthAggregateTotals, args)).toEqual([]);
    await expect(h.t.mutation(verification.markPipelineHealthAggregatesVerified, args))
      .rejects.toThrow("assert predates backfill");
    expect((await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))!.pipelineHealthAggregatesVerifiedAt).toBeUndefined();
  });

  it("mark refuses a failed assert even if totals match and succeeds after a passing rerun", async () => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    const id = await h.deal();
    for (const name of migrationNames.slice(0, 2)) await runMigration(h, name);
    await h.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", id))!;
      await openDealAging.replace(ctx, deal, { ...deal, nextMeetingAt: NOW });
    });
    expect(await runMigration(h, "assertPipelineHealthAggregates")).toMatchObject({ isDone: false, state: "failed" });
    const args = { tenantId: h.tenantId };
    expect(await h.t.query(verification.verifyPipelineHealthAggregateTotals, args)).toEqual([]);
    await expect(h.t.mutation(verification.markPipelineHealthAggregatesVerified, args))
      .rejects.toThrow("migration incomplete: migrations:assertPipelineHealthAggregates");
    expect((await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))!.pipelineHealthAggregatesVerifiedAt).toBeUndefined();
    await h.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", id))!;
      await openDealAging.replace(ctx, { ...deal, nextMeetingAt: NOW }, deal);
    });
    expect(await runMigration(h, "assertPipelineHealthAggregates")).toMatchObject({ isDone: true, state: "success" });
    await h.t.mutation(verification.markPipelineHealthAggregatesVerified, args);
    expect((await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))!.pipelineHealthAggregatesVerifiedAt).toBe(NOW);
  });

  it("keeps both public reports identical with the gate off and on, including date boundaries", async () => {
    const h = await pipelineHealthFixture();
    migrationsTest.register(h.t);
    await h.deal("qualified_pending", { createdAt: NOW - 5 * DAY });
    await h.deal("scheduled", { createdAt: NOW - 40 * DAY });
    await h.deal("scheduled", { createdAt: NOW - DAY, nextMeetingAt: NOW - 14 * DAY });
    await h.deal("follow_up_scheduled", { createdAt: NOW - 50 * DAY, nextMeetingAt: NOW - 15 * DAY });
    await h.deal("payment_received", { paymentReceivedAt: NOW - 20 * DAY });
    await h.deal("lost", { lostAt: MONTH.startDate, lostByUserId: h.actorId });
    await h.deal("lost", { lostAt: MONTH.startDate + DAY });
    await h.deal("lost", { lostAt: MONTH.endDate, lostByUserId: h.actorId });
    await h.deal("no_show", { lostAt: NOW, lostReason: "no_show" });
    const read = async () => ({
      aging: await h.admin.query(api.reporting.pipelineHealth.getPipelineAging, {}),
      losses: await h.admin.query(api.reporting.pipelineHealth.getPipelineBacklogAndLoss, MONTH),
    });
    const before = await read();
    await completeMigrations(h);
    const args = { tenantId: h.tenantId };
    expect(await h.t.query(verification.verifyPipelineHealthAggregateTotals, args)).toEqual([]);
    await h.t.mutation(verification.markPipelineHealthAggregatesVerified, args);
    expect((await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))!.pipelineHealthAggregatesVerifiedAt).toBe(NOW);
    expect(await read()).toEqual(before);
    expect(before.losses.lossAttribution).toMatchObject({ closer: 1, unknown: 1 });
    expect(before.aging.staleCount).toBe(3);
  });
});
