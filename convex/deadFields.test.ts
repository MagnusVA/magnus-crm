import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { book, enrollmentHarness, insertDeal, insertPerson } from "../tests/enrollmentFixtures";
import { opportunityByStage } from "./reporting/aggregates";

afterEach(() => vi.useRealTimers());

describe("clearDealMeetingTimes", () => {
  it("clears either or both copies across tenants, preserves other state, and reruns unchanged", async () => {
    const h = await enrollmentHarness();
    const booked = await book(h, "clear-times");
    const ids = await h.t.run(async (ctx) => {
      const otherTenantId = await ctx.db.insert("tenants", {
        companyName: "Other", contactEmail: "other@example.com", workosOrgId: "org_other",
        status: "active", inviteExpiresAt: 0, createdBy: "test",
      });
      const ids = [booked.opportunityId];
      for (const tenantId of [h.tenantId, otherTenantId]) {
        const leadId = await insertPerson(ctx, tenantId);
        for (const fields of [{ canceledAt: 0 }, { noShowAt: 0 }, {}]) {
          const id = await insertDeal(ctx, tenantId, leadId);
          await ctx.db.patch("opportunities", id, fields);
          ids.push(id);
        }
      }
      await ctx.db.patch("opportunities", booked.opportunityId, { canceledAt: 10, noShowAt: 20 });
      await ctx.db.patch("meetings", booked.meetingId, { canceledAt: 10, noShowMarkedAt: 20 });
      return ids;
    });
    const snapshot = () => h.t.run(async (ctx) => ({
      deals: await Promise.all(ids.map((id) => ctx.db.get("opportunities", id))),
      meetings: await ctx.db.query("meetings").take(10),
      events: await ctx.db.query("domainEvents").take(20),
      search: await ctx.db.query("opportunitySearch").take(10),
      customers: await ctx.db.query("leadCustomerSearchRows").take(10),
      qualifications: await ctx.db.query("operationsQualificationRows").take(10),
      projections: await ctx.db.query("meetingProjections").take(10),
      buckets: await ctx.db.query("operationsMeetingStatsV2").take(10),
      attributions: await ctx.db.query("dealAttributions").take(10),
      aggregateCount: await opportunityByStage.count(ctx, { namespace: h.tenantId }),
    }));
    const before = await snapshot();
    expect((await h.run("assertDealMeetingTimesCleared"))?.error).toContain(booked.opportunityId);
    await h.t.mutation(internal.migrations.run, { fn: "migrations:clearDealMeetingTimes", dryRun: true });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await snapshot()).toEqual(before);

    expect((await h.run("clearDealMeetingTimes"))?.error).toBeUndefined();
    expect((await h.rerun("assertDealMeetingTimesCleared"))?.error).toBeUndefined();
    const expected = {
      ...before,
      deals: before.deals.map((deal) => {
        const { canceledAt, noShowAt, ...rest } = deal!;
        void canceledAt;
        void noShowAt;
        return rest;
      }),
    };
    expect(await snapshot()).toEqual(expected);
    const e2e = await h.t.query(internal.testing.e2e.getOpportunitySnapshot, {
      opportunityId: booked.opportunityId,
    });
    expect(e2e?.opportunity).toMatchObject({ canceledAt: 10, noShowAt: 20 });
    expect((await h.rerun("clearDealMeetingTimes"))?.error).toBeUndefined();
    expect(await snapshot()).toEqual(expected);
  });

  it.each(["canceledAt", "noShowAt"] as const)("the assertion catches %s alone, including zero", async (field) => {
    const h = await enrollmentHarness();
    const id = await h.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, h.tenantId);
      const id = await insertDeal(ctx, h.tenantId, leadId);
      await ctx.db.patch("opportunities", id, { [field]: 0 });
      return id;
    });
    expect((await h.run("assertDealMeetingTimesCleared"))?.error).toContain(id);
  });
});

it("deletes legacy daily stats across tenants, keeps V2, supports dry run and rerun", async () => {
  const h = await enrollmentHarness();
  await book(h, "legacy-stats");
  const ids = await h.t.run(async (ctx) => {
    const otherTenantId = await ctx.db.insert("tenants", {
      companyName: "Other", contactEmail: "other@example.com", workosOrgId: "org_other",
      status: "active", inviteExpiresAt: 0, createdBy: "test",
    });
    const ids = [];
    for (const tenantId of [h.tenantId, otherTenantId]) {
      ids.push(await ctx.db.insert("operationsMeetingDailyStats", {
        tenantId, assignedCloserId: h.closerId, dayKey: "2026-10-01",
        meetingStatus: "scheduled", count: 5, updatedAt: 0,
      }));
    }
    return ids;
  });
  const snapshot = () => h.t.run(async (ctx) => ({
    legacy: await ctx.db.query("operationsMeetingDailyStats").take(10),
    v2: await ctx.db.query("operationsMeetingStatsV2").take(10),
    meetings: await ctx.db.query("meetings").take(10),
    projections: await ctx.db.query("meetingProjections").take(10),
  }));
  const before = await snapshot();
  expect(before.v2).toHaveLength(1);
  expect((await h.run("assertLegacyMeetingDailyStatsEmpty"))?.error).toContain(ids[0]);
  await h.t.mutation(internal.migrations.run, { fn: "migrations:deleteLegacyMeetingDailyStats", dryRun: true });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await snapshot()).toEqual(before);
  expect((await h.run("deleteLegacyMeetingDailyStats"))?.error).toBeUndefined();
  expect((await h.rerun("assertLegacyMeetingDailyStatsEmpty"))?.error).toBeUndefined();
  expect(await snapshot()).toEqual({ ...before, legacy: [] });
  expect((await h.rerun("deleteLegacyMeetingDailyStats"))?.error).toBeUndefined();
  expect(await snapshot()).toEqual({ ...before, legacy: [] });
});

it.each(["closer", "admin"] as const)("%s no-show writes meeting times and the E2E snapshot reads them", async (actor) => {
  const h = await enrollmentHarness();
  const { meetingId, opportunityId } = await book(h, `no-show-${actor}`);
  if (actor === "closer") {
    await h.closer.mutation(api.closer.noShowActions.markNoShow, { meetingId, reason: "no_response" });
  } else {
    await h.admin.mutation(api.admin.meetingActions.adminMarkNoShow, { meetingId, reason: "no_response" });
  }
  const { deal, meeting } = await h.t.run(async (ctx) => ({
    deal: await ctx.db.get("opportunities", opportunityId),
    meeting: await ctx.db.get("meetings", meetingId),
  }));
  expect(deal).not.toHaveProperty("noShowAt");
  expect(deal).not.toHaveProperty("canceledAt");
  expect(meeting?.noShowMarkedAt).toBe(Date.now());
  expect(deal?.lostAt).toBe(meeting?.noShowMarkedAt);
  const snapshot = await h.t.query(internal.testing.e2e.getOpportunitySnapshot, { opportunityId });
  expect(snapshot?.opportunity.noShowAt).toBe(meeting?.noShowMarkedAt);
  expect(snapshot?.opportunity.canceledAt).toBeNull();
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
});
