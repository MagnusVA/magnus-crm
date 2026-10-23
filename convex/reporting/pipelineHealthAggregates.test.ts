import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { ALL_MONTHS, DAY, MONTH, NOW, pipelineHealthFixture } from "../../tests/pipelineHealthAggregateFixtures";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import { insertLatestMeeting } from "../../tests/dealStageFixtures";
import { patchOpportunityLifecycle, transitionOpportunity } from "../lib/opportunityActivity";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { deleteOpportunityAggregate } from "./writeHooks";
import { openDealAging, personLosses } from "./pipelineHealthAggregates";

const verification = internal.reporting.pipelineHealthVerification;
const backfill = internal.reporting.backfill;
afterEach(() => vi.useRealTimers());

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
    const id = await h.deal();
    await h.deal("lost", { lostAt: NOW, lostByUserId: h.actorId });
    await h.deal("no_show", { lostAt: NOW, lostReason: "no_show" });
    await h.deal("lost", { lostReason: "Budget" });
    await h.t.run(async (ctx) => {
      const doc = (await ctx.db.get("opportunities", id))!;
      const { _id: _id, _creationTime: _creationTime, ...fields } = doc;
      for (let i = 0; i < 200; i++) await ctx.db.insert("opportunities", fields);
      await openDealAging.clear(ctx, { namespace: h.tenantId });
      await personLosses.clear(ctx, { namespace: h.tenantId });
    });
    for (let run = 0; run < 2; run++) {
      expect((await h.t.mutation(backfill.backfillOpenDealAging, {})).hasMore).toBe(true);
      await h.t.mutation(backfill.backfillPersonLosses, {});
      await h.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await h.t.run((ctx) => openDealAging.count(ctx, { namespace: h.tenantId }))).toBe(201);
      expect(await h.t.run((ctx) => personLosses.count(ctx, { namespace: h.tenantId }))).toBe(1);
    }
    expect(await h.t.query(verification.verifyPipelineHealthAggregates, { tenantId: h.tenantId, ...MONTH })).toEqual([]);
  });

  it("detects missing and extra stage entries, stale-only drift and actor drift; mark refuses them", async () => {
    const h = await pipelineHealthFixture();
    const id = await h.deal();
    const lossId = await h.deal("lost", { lostAt: NOW, lostByUserId: h.actorId });
    const args = { tenantId: h.tenantId, ...ALL_MONTHS };
    expect(await h.t.query(verification.verifyPipelineHealthAggregates, args)).toEqual([]);
    const original = await h.t.run((ctx) => ctx.db.get("opportunities", id));
    await h.t.run(async (ctx) => {
      await openDealAging.deleteIfExists(ctx, original!);
      await openDealAging.insertIfDoesNotExist(ctx, { ...original!, stage: "follow_up", nextMeetingAt: NOW });
    });
    const stageDiffs = await h.t.query(verification.verifyPipelineHealthAggregates, args);
    expect(stageDiffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "booked", metric: "count", source: 1, aggregate: 0 }),
      expect.objectContaining({ scope: "follow_up", metric: "count", source: 0, aggregate: 1 }),
    ]));
    await expect(h.t.mutation(verification.markPipelineHealthAggregatesVerified, args)).rejects.toThrow("mismatch");
    expect((await h.t.run((ctx) => ctx.db.get("tenants", h.tenantId)))!.pipelineHealthAggregatesVerifiedAt).toBeUndefined();
    await h.t.run(async (ctx) => {
      await openDealAging.deleteIfExists(ctx, { ...original!, stage: "follow_up", nextMeetingAt: NOW });
      await openDealAging.insertIfDoesNotExist(ctx, { ...original!, nextMeetingAt: NOW });
      const loss = (await ctx.db.get("opportunities", lossId))!;
      await personLosses.deleteIfExists(ctx, loss);
      await personLosses.insertIfDoesNotExist(ctx, { ...loss, lostByUserId: undefined });
    });
    expect(await h.t.query(verification.verifyPipelineHealthAggregates, args)).toEqual(expect.arrayContaining([
      { scope: "booked", metric: "staleCount", source: 1, aggregate: 0 },
      { scope: `${MONTH.startDate}:${h.actorId}`, metric: "count", source: 1, aggregate: 0 },
      { scope: `${MONTH.startDate}:`, metric: "count", source: 0, aggregate: 1 },
    ]));
    await expect(h.t.mutation(verification.markPipelineHealthAggregatesVerified, args)).rejects.toThrow("mismatch");
  });

  it("keeps both public reports identical with the gate off and on, including date boundaries", async () => {
    const h = await pipelineHealthFixture();
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
    await expect(h.t.mutation(verification.markPipelineHealthAggregatesVerified, { tenantId: h.tenantId, ...MONTH })).rejects.toThrow("every month");
    const args = { tenantId: h.tenantId, ...ALL_MONTHS };
    expect(await h.t.query(verification.verifyPipelineHealthAggregates, args)).toEqual([]);
    await h.t.mutation(verification.markPipelineHealthAggregatesVerified, args);
    expect(await read()).toEqual(before);
    expect(before.losses.lossAttribution).toMatchObject({ closer: 1, unknown: 1 });
    expect(before.aging.staleCount).toBe(3);
  });
});
