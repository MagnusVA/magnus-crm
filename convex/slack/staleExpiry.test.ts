import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { rebuildQualificationRow } from "../operations/projections";
import { slackQualificationsByUser } from "../reporting/aggregates";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { bookingHarness } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-14T12:00:00Z");

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function slackOpportunity(harness: Harness, ageDays: number) {
  const { t, tenantId } = harness;
  return await t.run(async (ctx) => {
    const createdAt = NOW - ageDays * DAY_MS;
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      fullName: `Lead ${ageDays}`,
      status: "active",
      firstSeenAt: createdAt,
      updatedAt: createdAt,
    });
    const qualifiedBy = { slackUserId: "U1", slackTeamId: "T1", submittedAt: createdAt };
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      status: "qualified_pending",
      source: "slack_qualified",
      qualifiedBy,
      createdAt,
      updatedAt: createdAt,
    });
    await insertOpportunityAggregate(ctx, opportunityId);
    await updateTenantStats(ctx, tenantId, {
      totalOpportunities: 1,
      activeOpportunities: 1,
    });
    const installation = await ctx.db.query("slackInstallations").first();
    const installationId =
      installation?._id ??
      (await ctx.db.insert("slackInstallations", {
        tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
        botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
        notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
        installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
      }));
    const eventId = await ctx.db.insert("slackQualificationEvents", {
      tenantId, installationId, leadId, opportunityId,
      resultKind: "created_opportunity", qualifiedBy,
      slackUserId: "U1", slackTeamId: "T1", fullNameSnapshot: `Lead ${ageDays}`,
      platform: "instagram", handleSnapshot: `lead.${ageDays}`,
      submittedAt: createdAt, createdAt,
    });
    await rebuildQualificationRow(ctx, eventId);
    return { opportunityId, eventId };
  });
}

async function state(harness: Harness, opportunityId: Id<"opportunities">, eventId: Id<"slackQualificationEvents">) {
  return await harness.t.run(async (ctx) => ({
    opportunity: await ctx.db.get("opportunities", opportunityId),
    row: await ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_qualificationEventId", (q) => q.eq("qualificationEventId", eventId))
      .unique(),
  }));
}

it("closes Slack opportunities a day past the join window and leaves younger ones", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  const stale = await slackOpportunity(harness, 32);
  const inDigestWindow = await slackOpportunity(harness, 30.5);
  const fresh = await slackOpportunity(harness, 3);

  await harness.t.mutation(internal.slack.staleExpiry.expireStaleSlackOpportunities, {});

  const closed = await state(harness, stale.opportunityId, stale.eventId);
  expect(closed.opportunity).toMatchObject({ status: "lost", lostReason: "stale", lostAt: NOW });
  expect(closed.row?.opportunityStatus).toBe("lost");
  for (const open of [inDigestWindow, fresh]) {
    expect((await state(harness, open.opportunityId, open.eventId)).opportunity?.status)
      .toBe("qualified_pending");
  }

  const counts = await harness.t.run(async (ctx) => ({
    stats: await ctx.db
      .query("tenantStats")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", harness.tenantId))
      .unique(),
    // Expiry is an outcome, not a lost qualification: the setter's count stays.
    qualifications: await slackQualificationsByUser.count(ctx, {
      namespace: harness.tenantId,
      bounds: { prefix: ["U1"] },
    }),
    events: await ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", harness.tenantId).eq("entityType", "opportunity")
          .eq("entityId", stale.opportunityId),
      )
      .take(5),
  }));
  expect(counts.stats).toMatchObject({ activeOpportunities: 2, lostDeals: 1 });
  expect(counts.qualifications).toBe(3);
  expect(counts.events).toEqual([
    expect.objectContaining({
      eventType: "opportunity.marked_lost",
      source: "system",
      fromStatus: "qualified_pending",
      toStatus: "lost",
      reason: "stale",
    }),
  ]);
});

it("works through a backlog in batches", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  const backlog: Awaited<ReturnType<typeof slackOpportunity>>[] = [];
  for (let index = 0; index < 23; index += 1) {
    backlog.push(await slackOpportunity(harness, 40 + index));
  }

  await harness.t.mutation(internal.slack.staleExpiry.expireStaleSlackOpportunities, {});
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

  const statuses = await harness.t.run(async (ctx) =>
    Promise.all(
      backlog.map(async ({ opportunityId }) =>
        (await ctx.db.get("opportunities", opportunityId))?.status,
      ),
    ),
  );
  expect(new Set(statuses)).toEqual(new Set(["lost"]));
});

it("counts the backlog without changing anything", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  const stale = await slackOpportunity(harness, 45);
  await slackOpportunity(harness, 10);

  const preview = await harness.t.query(
    internal.slack.staleExpiry.previewStaleSlackOpportunities,
    {},
  );

  expect(preview).toEqual({
    count: 1,
    capped: false,
    oldestCreatedAt: NOW - 45 * DAY_MS,
  });
  expect((await state(harness, stale.opportunityId, stale.eventId)).opportunity?.status)
    .toBe("qualified_pending");
});
