import { afterEach, expect, it, vi } from "vitest";
import { attributionHarness, attributionRows, AT } from "../../tests/attributionFixtures";
import { internal } from "../_generated/api";
import {
  deleteDealAttributions,
  deleteMeetingAttributions,
  moveMeetingAttributions,
  recordDealCreation,
  repointDealAttributionTeamMember,
} from "../lib/attribution/dealAttributions";
import {
  insertLeadGenDealAggregate,
  isLeadGenDealAggregateEligible,
  leadGenDealsByWorker,
} from "./leadGenDealsAggregate";

afterEach(() => vi.useRealTimers());

const functions = internal.leadGen.leadGenDealsAggregate;
const range = { startAt: AT.CAPTURED, endAt: AT.CAPTURED + 1 };
type Harness = Awaited<ReturnType<typeof attributionHarness>>;

async function count(h: Harness) {
  return await h.t.run((ctx) => leadGenDealsByWorker.count(ctx, { namespace: h.tenantId }));
}

it("inserts once through deal creation and ignores both kinds of ineligible row", async () => {
  const h = await attributionHarness();
  expect(await count(h)).toBe(1);
  await h.t.run((ctx) => recordDealCreation(ctx, h.ids.opportunities.o1));
  expect(await count(h)).toBe(1);
  await h.t.run(async (ctx) => {
    const row = (await ctx.db.query("dealAttributions")
      .withIndex("by_tenantId_and_role_and_attributedAt", (q) =>
        q.eq("tenantId", h.tenantId).eq("role", "lead_gen")).first())!;
    const { _id, _creationTime, ...fields } = row;
    for (const patch of [
      { role: "setter" as const },
      { source: { kind: "booking_utm" as const } },
    ]) {
      const id = await ctx.db.insert("dealAttributions", { ...fields, ...patch });
      await insertLeadGenDealAggregate(ctx, (await ctx.db.get("dealAttributions", id))!);
    }
  });
  expect(await count(h)).toBe(1);
  expect(await h.t.query(functions.verifyLeadGenDealsByWorker, { tenantId: h.tenantId, ...range })).toEqual([]);
});

it.each(["deal", "meeting"] as const)("deletes eligible credit through the %s helper", async (kind) => {
  const h = await attributionHarness();
  const row = (await attributionRows(h)).find(isLeadGenDealAggregateEligible)!;
  await h.t.run(async (ctx) => {
    if (kind === "deal") {
      expect(await deleteDealAttributions(ctx, h.tenantId, h.ids.opportunities.o1)).toBe(true);
    } else {
      // Normally a capture has no meeting. The central eligibility guard
      // must still handle one in the meeting delete path.
      await ctx.db.patch("dealAttributions", row._id, { meetingId: h.ids.meetings.m1 });
      await deleteMeetingAttributions(ctx, h.tenantId, h.ids.meetings.m1);
    }
  });
  expect(await count(h)).toBe(0);
});

it("backfills idempotently, catches missing and stale credit, and refuses to mark a mismatch", async () => {
  const h = await attributionHarness();
  const row = (await attributionRows(h)).find(isLeadGenDealAggregateEligible)!;
  await h.t.run((ctx) => leadGenDealsByWorker.deleteIfExists(ctx, row));
  expect(await h.t.query(functions.verifyLeadGenDealsByWorker, { tenantId: h.tenantId, ...range }))
    .toEqual([{ workerId: h.ids.workerId, sourceCount: 1, aggregateCount: 0 }]);
  await expect(h.t.mutation(functions.markLeadGenDealsByWorkerVerified, { tenantId: h.tenantId }))
    .rejects.toThrow("Attribution aggregate mismatch");
  expect(await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))
    .not.toHaveProperty("leadGenDealsAggregateVerifiedAt");
  expect((await h.run("backfillLeadGenDealsByWorker"))?.state).toBe("success");
  expect((await h.rerun("backfillLeadGenDealsByWorker"))?.state).toBe("success");
  expect(await count(h)).toBe(1);
  expect(await h.t.query(functions.verifyLeadGenDealsByWorker, { tenantId: h.tenantId, ...range })).toEqual([]);
  await h.t.mutation(functions.markLeadGenDealsByWorkerVerified, { tenantId: h.tenantId });
  expect(await h.t.run(async (ctx) => (await ctx.db.get("tenants", h.tenantId))!.leadGenDealsAggregateVerifiedAt))
    .toBe(Date.now());

  // Deliberately bypass the delete hook, leaving aggregate-only credit.
  await h.t.run((ctx) => ctx.db.delete("dealAttributions", row._id));
  expect(await h.t.query(functions.verifyLeadGenDealsByWorker, { tenantId: h.tenantId, ...range }))
    .toEqual([{ workerId: h.ids.workerId, sourceCount: 0, aggregateCount: 1 }]);
  const markedAt = Date.now();
  vi.setSystemTime(markedAt + 1000);
  await expect(h.t.mutation(functions.markLeadGenDealsByWorkerVerified, { tenantId: h.tenantId }))
    .rejects.toThrow("Attribution aggregate mismatch");
  expect(await h.t.run(async (ctx) => (await ctx.db.get("tenants", h.tenantId))!.leadGenDealsAggregateVerifiedAt))
    .toBe(markedAt);
});

it("keeps row identities, capture boundaries and tenant isolation", async () => {
  const h = await attributionHarness();
  const row = (await attributionRows(h)).find(isLeadGenDealAggregateEligible)!;
  await h.t.run(async (ctx) => {
    const { _id, _creationTime, ...fields } = row;
    // Two rows on one deal still count twice, unlike distinct-deal counting.
    const id = await ctx.db.insert("dealAttributions", fields);
    await insertLeadGenDealAggregate(ctx, (await ctx.db.get("dealAttributions", id))!);
    const otherTenant = await ctx.db.insert("tenants", {
      companyName: "Other", contactEmail: "other@example.com", workosOrgId: "org_other",
      status: "active", inviteExpiresAt: 0, createdBy: "test",
    });
    const foreignId = await ctx.db.insert("dealAttributions", { ...fields, tenantId: otherTenant });
    await insertLeadGenDealAggregate(ctx, (await ctx.db.get("dealAttributions", foreignId))!);
    const counts = await leadGenDealsByWorker.countBatch(ctx, [
      { namespace: h.tenantId, bounds: {
        lower: { key: [h.ids.workerId, AT.CAPTURED], inclusive: true },
        upper: { key: [h.ids.workerId, AT.CAPTURED + 1], inclusive: false },
      } },
      { namespace: h.tenantId, bounds: {
        lower: { key: [h.ids.workerId, AT.CAPTURED - 1], inclusive: true },
        upper: { key: [h.ids.workerId, AT.CAPTURED], inclusive: false },
      } },
      { namespace: h.tenantId, bounds: {
        lower: { key: [h.ids.workerId, AT.QUALIFIED], inclusive: true },
        upper: { key: [h.ids.workerId, AT.QUALIFIED + 1], inclusive: false },
      } },
    ]);
    expect(counts).toEqual([2, 0, 0]);
  });
  expect(await h.t.query(functions.verifyLeadGenDealsByWorker, { tenantId: h.tenantId, ...range })).toEqual([]);
});

it("moving meetings and repointing humans leaves capture credit unchanged", async () => {
  const h = await attributionHarness();
  await h.t.run(async (ctx) => {
    await moveMeetingAttributions(ctx, {
      tenantId: h.tenantId, meetingId: h.ids.meetings.m1, toOpportunityId: h.ids.opportunities.o2,
    });
    await repointDealAttributionTeamMember(ctx, {
      tenantId: h.tenantId, fromTeamMemberId: h.ids.tm.admin, intoTeamMemberId: h.ids.tm.closer, limit: 200,
    });
  });
  await h.t.mutation(internal.attribution.teamMemberRepoint.repointRoleRecordRows, {
    tenantId: h.tenantId, role: "lead_gen", recordKey: h.ids.workerId,
    fromTeamMemberId: h.ids.tm.closer, intoTeamMemberId: h.ids.tm.admin,
  });
  expect(await count(h)).toBe(1);
  expect(await h.t.query(functions.verifyLeadGenDealsByWorker, { tenantId: h.tenantId, ...range })).toEqual([]);
});

it.each(["tenant", "testing"] as const)("removes aggregate credit in %s cleanup", async (kind) => {
  const h = await attributionHarness();
  if (kind === "tenant") {
    await h.t.mutation(internal.admin.tenantsMutations.deleteTenantRuntimeDataBatch, { tenantId: h.tenantId });
  } else {
    await h.t.mutation(internal.testing.operationalData.deleteOperationalDataBatch, { tableName: "dealAttributions" });
  }
  expect(await count(h)).toBe(0);
});

it("refuses to enable the reader when an entry has the wrong capture time but the same all-time count", async () => {
  const h = await attributionHarness();
  const row = (await attributionRows(h)).find(isLeadGenDealAggregateEligible)!;
  await h.t.run(async (ctx) => {
    await leadGenDealsByWorker.replaceOrInsert(ctx, row, { ...row, attributedAt: AT.QUALIFIED });
  });
  expect(await count(h)).toBe(1);
  expect(await h.t.query(functions.verifyLeadGenDealsByWorker, { tenantId: h.tenantId, ...range }))
    .toEqual([{ workerId: h.ids.workerId, sourceCount: 1, aggregateCount: 0 }]);
  await expect(h.t.mutation(functions.markLeadGenDealsByWorkerVerified, { tenantId: h.tenantId }))
    .rejects.toThrow("Attribution aggregate mismatch");
  expect(await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))
    .not.toHaveProperty("leadGenDealsAggregateVerifiedAt");
});
