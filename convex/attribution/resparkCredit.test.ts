import { afterEach, describe, expect, it, vi } from "vitest";
import migrationsTest from "@convex-dev/migrations/test";
import { bookingHarness } from "../../tests/bookingHarness";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { attributionsForDeal, recordDealCreation } from "../lib/attribution/dealAttributions";
import { leadGenDealsByWorker } from "../leadGen/leadGenDealsAggregate";
import { insertResparkItem, workResparkItem } from "../lib/respark/items";
import { migrations } from "../migrations";
import { executeMerge } from "../leads/merge";
import { DAY_MS } from "../lib/respark/settings";

const NOW = Date.parse("2026-10-20T15:00:00Z");
type Harness = Awaited<ReturnType<typeof bookingHarness>>;
afterEach(() => vi.useRealTimers());

async function seed(work = true) {
  vi.useFakeTimers();
  const h = await bookingHarness();
  migrationsTest.register(h.t);
  vi.setSystemTime(NOW - 40 * DAY_MS);
  const capture = await h.admin.mutation(api.leadGen.capture.submit, {
    source: "instagram", rawHandleOrProfileUrl: "@respark.credit", originKind: "follower",
  });
  await h.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { tenantId: h.tenantId, workosUserId: "resparker",
      email: "resparker@example.com", role: "lead_generator", isActive: true });
    await ctx.db.insert("leadGenWorkers", { tenantId: h.tenantId, userId, workosUserId: "resparker",
      email: "resparker@example.com", displayName: "Resparker", isActive: true, createdAt: NOW, updatedAt: NOW });
  });
  const caller = h.t.withIdentity({ subject: "resparker", org_id: "org_test" });
  vi.setSystemTime(NOW);
  const { batchId } = await caller.mutation(api.respark.batches.claimResparkBatch, {});
  const [item] = await h.t.run((ctx) => ctx.db.query("resparkBatchItems")
    .withIndex("by_batchId_and_position", (q) => q.eq("batchId", batchId!)).take(1));
  if (work) await caller.mutation(api.respark.batches.markResparked, { itemId: item._id });
  return { ...h, caller, leadId: capture.leadId!, item };
}

async function newDeal(h: Harness & { leadId: Id<"leads"> }, createdAt = NOW + 1000) {
  vi.setSystemTime(createdAt);
  return await h.t.run(async (ctx) => {
    const id = await ctx.db.insert("opportunities", { tenantId: h.tenantId, leadId: h.leadId,
      stage: "closed", outcome: "lost", source: "calendly", createdAt, updatedAt: createdAt });
    await ctx.db.insert("domainEvents", { tenantId: h.tenantId, leadId: h.leadId,
      entityType: "opportunity", entityId: id, eventType: "opportunity.created", source: "pipeline", occurredAt: createdAt });
    await recordDealCreation(ctx, id);
    return id;
  });
}
async function rows(h: Harness, id: Id<"opportunities">) {
  return await h.t.run((ctx) => attributionsForDeal(ctx, h.tenantId, id));
}
async function assertRows(h: Harness) {
  await h.t.mutation(internal.migrations.run, { fn: "migrations:assertDealAttributions", reset: true });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [status] = await h.t.run((ctx) => migrations.getStatus(ctx, {
    migrations: ["migrations:assertDealAttributions"] as never,
  }));
  return status?.error;
}

describe("Respark credit", () => {
  it("adds the worker's credit beside capture, once, at workedAt; Deals counts only capture", async () => {
    const h = await seed();
    const id = await newDeal(h);
    await h.t.run((ctx) => recordDealCreation(ctx, id));
    const credit = await rows(h, id);
    expect(credit.map((row) => row.source.kind)).toEqual(["capture", "respark"]);
    const worker = await h.t.run((ctx) => ctx.db.get("leadGenWorkers", h.item.workerId));
    expect(credit[0].teamMemberId).not.toBe(worker!.teamMemberId);
    expect(credit[1]).toMatchObject({ role: "lead_gen", teamMemberId: worker!.teamMemberId,
      attributedAt: NOW, source: { kind: "respark", itemId: h.item._id, workerId: worker!._id } });
    expect(await h.t.run((ctx) => leadGenDealsByWorker.count(ctx, { namespace: h.tenantId }))).toBe(1);
    // The fallback and aggregate-backed Deals column both exclude Respark.
    for (const verified of [undefined, NOW]) {
      await h.t.run((ctx) => ctx.db.patch("tenants", h.tenantId, { leadGenDealsAggregateVerifiedAt: verified }));
      const report = await h.admin.query(api.leadGen.conversions.listProspectConversions, {
        startDayKey: "2026-09-01", endDayKey: "2026-10-21",
      });
      expect(report.rows.reduce((total, row) => total + row.deals, 0)).toBe(1);
    }
    expect(await assertRows(h)).toBeUndefined();
  });

  it("does not credit the next attempt with a respark before its previous deal", async () => {
    const h = await seed();
    await newDeal(h);
    const next = await newDeal(h, NOW + 2000);
    expect((await rows(h, next)).map((row) => row.source.kind)).toEqual(["capture"]);
  });

  it("credits a respark across a person merge, and excludes one before a previous merged deal", async () => {
    const h = await seed();
    const target = await h.t.run(async (ctx) => {
      const target = await ctx.db.insert("leads", { tenantId: h.tenantId, status: "active",
        firstSeenAt: NOW, updatedAt: NOW, lifecycleStage: "prospect", lifecycleStageEnteredAt: {}, disposition: "open" });
      await executeMerge(ctx, h.tenantId, h.item.userId, h.leadId, target);
      return target;
    });
    const merged = { ...h, leadId: target };
    const first = await newDeal(merged);
    expect((await rows(h, first)).find((row) => row.source.kind === "respark")?.source)
      .toMatchObject({ itemId: h.item._id });
    const next = await newDeal(merged, NOW + 2000);
    expect((await rows(h, next)).some((row) => row.source.kind === "respark")).toBe(false);
    expect(await assertRows(h)).toBeUndefined();
  });

  it("does not let a backdated import or a later merge invalidate historical credit", async () => {
    const h = await seed();
    vi.setSystemTime(NOW + 500);
    const other = await h.t.run(async (ctx) => {
      const other = await ctx.db.insert("leads", { tenantId: h.tenantId, status: "active", firstSeenAt: 0,
        updatedAt: 0, lifecycleStage: "prospect", lifecycleStageEnteredAt: {}, disposition: "open" });
      const prior = await ctx.db.insert("opportunities", { tenantId: h.tenantId, leadId: other,
        stage: "closed", outcome: "lost", createdAt: NOW + 500, updatedAt: NOW + 500 });
      await ctx.db.insert("domainEvents", { tenantId: h.tenantId, leadId: other, entityType: "opportunity",
        entityId: prior, eventType: "opportunity.created", source: "pipeline", occurredAt: NOW + 500 });
      await recordDealCreation(ctx, prior);
      return other;
    });
    await newDeal(h);
    vi.setSystemTime(NOW + 3000);
    await h.t.run(async (ctx) => {
      // This import did not exist when credit was written, even though its
      // business timestamp is between the respark and credited deal.
      const imported = await ctx.db.insert("opportunities", { tenantId: h.tenantId, leadId: h.leadId,
        stage: "closed", outcome: "lost", createdAt: NOW + 750, updatedAt: NOW + 750 });
      await ctx.db.insert("domainEvents", { tenantId: h.tenantId, leadId: h.leadId, entityType: "opportunity",
        entityId: imported, eventType: "opportunity.created", source: "pipeline", occurredAt: NOW + 750 });
      await recordDealCreation(ctx, imported);
      // And a person merged in after the credit brings an earlier deal.
      await executeMerge(ctx, h.tenantId, h.item.userId, other, h.leadId);
    });
    expect(await assertRows(h)).toBeUndefined();
  });

  it("rejects a stored respark that belongs to the previous attempt", async () => {
    const h = await seed();
    const first = await newDeal(h);
    const next = await newDeal(h, NOW + 2000);
    await h.t.run(async (ctx) => {
      const old = (await attributionsForDeal(ctx, h.tenantId, first)).find((row) => row.source.kind === "respark")!;
      const { _id, _creationTime, ...copy } = old; void _id; void _creationTime;
      await ctx.db.insert("dealAttributions", { ...copy, opportunityId: next, createdAt: NOW + 2000 });
    });
    expect(await assertRows(h)).toContain("predates deal");
  });

  it("requires workedAt strictly before the deal", async () => {
    const h = await seed();
    expect((await rows(h, await newDeal(h, NOW))).map((row) => row.source.kind)).toEqual(["capture"]);
  });

  it("adds no respark credit when there was no respark", async () => {
    const h = await seed(false);
    expect((await rows(h, await newDeal(h))).map((row) => row.source.kind)).toEqual(["capture"]);
  });

  it("adds a missing capture even when a respark row already exists", async () => {
    const h = await seed();
    const id = await newDeal(h);
    await h.t.run(async (ctx) => {
      const capture = (await attributionsForDeal(ctx, h.tenantId, id)).find((row) => row.source.kind === "capture")!;
      await leadGenDealsByWorker.delete(ctx, capture);
      await ctx.db.delete("dealAttributions", capture._id);
      await recordDealCreation(ctx, id);
    });
    expect((await rows(h, id)).map((row) => row.source.kind).sort()).toEqual(["capture", "respark"]);
  });

  it("repoints the resparking worker's credit with their team member", async () => {
    const h = await seed();
    const id = await newDeal(h);
    const credit = (await rows(h, id)).find((row) => row.source.kind === "respark")!;
    const into = await h.t.run((ctx) => ctx.db.insert("teamMembers", {
      tenantId: h.tenantId, displayName: "Linked member", createdAt: NOW, updatedAt: NOW,
    }));
    await h.t.mutation(internal.attribution.teamMemberRepoint.repointRoleRecordRows, {
      tenantId: h.tenantId, role: "lead_gen", recordKey: h.item.workerId,
      fromTeamMemberId: credit.teamMemberId!, intoTeamMemberId: into,
    });
    expect((await rows(h, id)).find((row) => row.source.kind === "respark")?.teamMemberId).toBe(into);
  });

  it("retains valid historical credit after a newer respark", async () => {
    const h = await seed();
    const id = await newDeal(h);
    await h.t.run(async (ctx) => {
      const itemId = await insertResparkItem(ctx, { tenantId: h.tenantId,
        batchId: h.item.batchId, leadId: h.leadId, userId: h.item.userId, workerId: h.item.workerId,
        position: 1, bucket: 2, heldUntil: NOW + 31 * DAY_MS });
      const eventId = await ctx.db.insert("domainEvents", { tenantId: h.tenantId, leadId: h.leadId,
        entityType: "lead", entityId: h.leadId, eventType: "lead.resparked", source: "pipeline", occurredAt: NOW + DAY_MS });
      await workResparkItem(ctx, (await ctx.db.get("resparkBatchItems", itemId))!, {
        result: "resparked", workedAt: NOW + DAY_MS, eventId,
      });
      await recordDealCreation(ctx, id);
    });
    expect((await rows(h, id)).find((row) => row.source.kind === "respark")?.attributedAt).toBe(NOW);
    expect(await assertRows(h)).toBeUndefined();
  });

  it.each(["duplicate", "worker", "event", "time", "result", "person"] as const)(
    "rejects invalid Respark evidence: %s", async (damage) => {
      const h = await seed();
      const id = await newDeal(h);
      const credit = (await rows(h, id)).find((row) => row.source.kind === "respark")!;
      await h.t.run(async (ctx) => {
        if (damage === "duplicate") {
          const { _id, _creationTime, ...copy } = credit; void _id; void _creationTime;
          await ctx.db.insert("dealAttributions", copy);
        } else if (damage === "worker") {
          const worker = await ctx.db.insert("leadGenWorkers", { tenantId: h.tenantId,
            userId: h.item.userId, workosUserId: "other", email: "other@example.com", isActive: true,
            createdAt: NOW, updatedAt: NOW });
          await ctx.db.patch("resparkBatchItems", h.item._id, { workerId: worker });
        } else if (damage === "event") {
          const item = (await ctx.db.get("resparkBatchItems", h.item._id))!;
          await ctx.db.patch("domainEvents", item.eventId!, { eventType: "lead.captured" });
        } else if (damage === "time") {
          await ctx.db.patch("dealAttributions", credit._id, { attributedAt: NOW + 1000 });
        } else if (damage === "result") {
          await ctx.db.patch("resparkBatchItems", h.item._id, { result: "skipped" });
        } else if (damage === "person") {
          const other = await ctx.db.insert("leads", { tenantId: h.tenantId, status: "active", firstSeenAt: 0,
            updatedAt: 0, lifecycleStage: "prospect", lifecycleStageEnteredAt: {}, disposition: "open" });
          await ctx.db.patch("resparkBatchItems", h.item._id, { leadId: other });
        }
      });
      expect(await assertRows(h)).toContain(damage === "duplicate" ? "respark rows" : "invalid respark row");
    });
});
