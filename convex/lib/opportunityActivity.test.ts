import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { rebuildQualificationRow } from "../operations/projections";
import { opportunityByStatus } from "../reporting/aggregates";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import { migrations } from "../migrations";
import {
  patchOpportunityLifecycle,
  transitionOpportunity,
} from "./opportunityActivity";
import { countsAsLead } from "./leadLifecycle";
import type { OpportunityStatus } from "./statusTransitions";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "./tenantStatsHelper";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

// A Slack-qualified opportunity with its qualification row, counted in the
// aggregates and tenant stats the way the real create paths count it.
async function slackOpportunity(
  harness: Harness,
  status: OpportunityStatus = "scheduled",
) {
  const { t, tenantId } = harness;
  return await t.run(async (ctx) => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(10);
    const closerId = users.find((user) => user.role === "closer")!._id;
    const now = Date.now();
    const leadId = await ctx.db.insert("leads", { ...qualifiedLifecycle(now),
      tenantId,
      email: "slack-lead@example.com",
      status: "active",
      firstSeenAt: now,
      updatedAt: now,
    });
    const qualifiedBy = { slackUserId: "U1", slackTeamId: "T1", submittedAt: now };
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      assignedCloserId: closerId,
      status,
      source: "slack_qualified",
      qualifiedBy,
      createdAt: now,
      updatedAt: now,
    });
    await insertOpportunityAggregate(ctx, opportunityId);
    await updateTenantStats(ctx, tenantId, {
      totalOpportunities: 1,
      activeOpportunities: isActiveOpportunityStatus(status) ? 1 : 0,
      wonDeals: status === "payment_received" ? 1 : 0,
      lostDeals: status === "lost" ? 1 : 0,
    });
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
      botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
      installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
    });
    const eventId = await ctx.db.insert("slackQualificationEvents", {
      tenantId,
      installationId,
      leadId,
      opportunityId,
      resultKind: "created_opportunity",
      qualifiedBy,
      slackUserId: "U1",
      slackTeamId: "T1",
      fullNameSnapshot: "Slack Lead",
      platform: "instagram",
      handleSnapshot: "slack.lead",
      submittedAt: now,
      createdAt: now,
    });
    await rebuildQualificationRow(ctx, eventId);
    return { leadId, opportunityId, closerId, eventId };
  });
}

async function readState(
  harness: Harness,
  opportunityId: Id<"opportunities">,
  eventId?: Id<"slackQualificationEvents">,
) {
  const { t, tenantId } = harness;
  return await t.run(async (ctx) => {
    const opportunity = await ctx.db.get("opportunities", opportunityId);
    const qualificationRow = eventId
      ? await ctx.db
          .query("operationsQualificationRows")
          .withIndex("by_qualificationEventId", (q) =>
            q.eq("qualificationEventId", eventId),
          )
          .unique()
      : null;
    const events = await ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("entityType", "opportunity")
          .eq("entityId", opportunityId),
      )
      .take(20);
    const stats = await ctx.db
      .query("tenantStats")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();
    const countByStatus = async (status: OpportunityStatus) =>
      await opportunityByStatus.count(ctx, {
        namespace: tenantId,
        bounds: { prefix: [status] },
      });
    return {
      opportunity,
      qualificationRow,
      events,
      stats,
      scheduledCount: await countByStatus("scheduled"),
      lostCount: await countByStatus("lost"),
      wonCount: await countByStatus("payment_received"),
    };
  });
}

// tenantStats must equal a recount from the opportunities, as
// seedTenantStatsInternal computes it.
async function expectStatsMatchRecount(harness: Harness) {
  const { t, tenantId } = harness;
  const { stats, opportunities } = await t.run(async (ctx) => ({
    stats: await ctx.db
      .query("tenantStats")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique(),
    opportunities: await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(100),
  }));
  expect({
    activeOpportunities: stats?.activeOpportunities ?? 0,
    wonDeals: stats?.wonDeals ?? 0,
    lostDeals: stats?.lostDeals ?? 0,
  }).toEqual({
    activeOpportunities: opportunities.filter((o) =>
      isActiveOpportunityStatus(o.status),
    ).length,
    wonDeals: opportunities.filter((o) => o.status === "payment_received").length,
    lostDeals: opportunities.filter((o) => o.status === "lost").length,
  });
}

// totalCustomers and totalLeads must equal a recount from the people, as
// seedTenantStatsInternal and countTenantLeadsPage compute them: a customer
// is a converted person (docs/plans/phase-4-customers.md §4.2, §4.3, §8).
async function expectPersonCountersMatchRecount(harness: Harness) {
  const { t, tenantId } = harness;
  const { stats, leads } = await t.run(async (ctx) => ({
    stats: await ctx.db
      .query("tenantStats")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique(),
    leads: await ctx.db
      .query("leads")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(100),
  }));
  expect({
    totalCustomers: stats?.totalCustomers ?? 0,
    totalLeads: stats?.totalLeads ?? 0,
  }).toEqual({
    totalCustomers: leads.filter((lead) => lead.status === "converted").length,
    totalLeads: leads.filter(countsAsLead).length,
  });
}

describe("transitionOpportunity", () => {
  it("moves the status with its aggregates, counters, event and qualification row", async () => {
    const harness = await bookingHarness();
    const { opportunityId, closerId, eventId } = await slackOpportunity(harness);

    await harness.t.run(async (ctx) => {
      await transitionOpportunity(ctx, opportunityId, {
        to: "lost",
        fields: { lostAt: 1_000, lostReason: "budget", lostByUserId: closerId },
        source: "closer",
        actorUserId: closerId,
        eventType: "opportunity.marked_lost",
        reason: "budget",
      });
    });

    const state = await readState(harness, opportunityId, eventId);
    expect(state.opportunity).toMatchObject({ status: "lost", lostReason: "budget" });
    expect(state.qualificationRow?.opportunityStatus).toBe("lost");
    expect(state.events).toEqual([
      expect.objectContaining({
        eventType: "opportunity.marked_lost",
        fromStatus: "scheduled",
        toStatus: "lost",
        actorUserId: closerId,
        reason: "budget",
      }),
    ]);
    expect([state.scheduledCount, state.lostCount]).toEqual([0, 1]);
    expect(state.stats).toMatchObject({ activeOpportunities: 0, lostDeals: 1 });
    await expectStatsMatchRecount(harness);
  });

  it.each([
    ["lost", "scheduled"],
    ["payment_received", "lost"],
    ["no_show", "canceled"],
    ["scheduled", "scheduled"],
  ] as const)(
    "rejects %s -> %s without a named exception and writes nothing",
    async (from, to) => {
      const harness = await bookingHarness();
      const { opportunityId } = await slackOpportunity(harness, from);
      const before = await readState(harness, opportunityId);

      await expect(
        harness.t.run(async (ctx) => {
          await transitionOpportunity(ctx, opportunityId, { to, source: "system" });
        }),
      ).rejects.toThrow(`Cannot transition opportunity from "${from}" to "${to}"`);

      const after = await readState(harness, opportunityId);
      expect(after.opportunity?.status).toBe(from);
      expect(after.events).toHaveLength(0);
      expect(after.stats).toEqual(before.stats);
    },
  );

  it.each([
    ["payment_received", "lost", "payment_voided"],
    ["no_show", "canceled", "calendly_webhook"],
    ["canceled", "no_show", "calendly_webhook"],
  ] as const)(
    "allows %s -> %s only for the %s exception",
    async (from, to, exception) => {
      const harness = await bookingHarness();
      const { opportunityId } = await slackOpportunity(harness, from);

      await harness.t.run(async (ctx) => {
        await transitionOpportunity(ctx, opportunityId, {
          to,
          source: "system",
          exception,
        });
      });

      expect((await readState(harness, opportunityId)).opportunity?.status).toBe(to);
      await expectStatsMatchRecount(harness);
    },
  );

  it("doesn't let one exception unlock another's moves", async () => {
    const harness = await bookingHarness();
    const { opportunityId } = await slackOpportunity(harness, "payment_received");

    await expect(
      harness.t.run(async (ctx) => {
        await transitionOpportunity(ctx, opportunityId, {
          to: "lost",
          source: "pipeline",
          exception: "calendly_webhook",
        });
      }),
    ).rejects.toThrow('Cannot transition opportunity from "payment_received" to "lost"');
  });
});

describe("patchOpportunityLifecycle", () => {
  it("re-keys the status aggregate and qualification row when the closer changes", async () => {
    const harness = await bookingHarness();
    const { opportunityId, closerId, eventId } = await slackOpportunity(harness);
    const otherCloserId = await harness.t.run(async (ctx) =>
      ctx.db.insert("users", {
        tenantId: harness.tenantId,
        workosUserId: "user_other_closer",
        email: "other@example.com",
        role: "closer",
        isActive: true,
      }),
    );

    await harness.t.run(async (ctx) => {
      await patchOpportunityLifecycle(ctx, opportunityId, {
        assignedCloserId: otherCloserId,
      });
    });

    const counts = await harness.t.run(async (ctx) => {
      const count = async (userId: Id<"users">) =>
        await opportunityByStatus.count(ctx, {
          namespace: harness.tenantId,
          bounds: { prefix: ["scheduled", userId] },
        });
      return [await count(closerId), await count(otherCloserId)];
    });
    expect(counts).toEqual([0, 1]);
    const state = await readState(harness, opportunityId, eventId);
    expect(state.qualificationRow?.assignedCloserId).toBe(otherCloserId);
  });

  it("refuses a status change", async () => {
    const harness = await bookingHarness();
    const { opportunityId } = await slackOpportunity(harness);

    await expect(
      harness.t.run(async (ctx) => {
        // @ts-expect-error status is not a patchable field
        await patchOpportunityLifecycle(ctx, opportunityId, { status: "lost" });
      }),
    ).rejects.toThrow("Use transitionOpportunity");
  });
});

describe("status changes through the public mutations", () => {
  it("keeps the qualification row current when a closer marks a deal lost", async () => {
    const harness = await bookingHarness();
    const { opportunityId, eventId } = await slackOpportunity(harness);

    await harness.closer.mutation(api.closer.meetingActions.markAsLost, {
      opportunityId,
      reason: "not a fit",
    });

    const state = await readState(harness, opportunityId, eventId);
    expect(state.qualificationRow?.opportunityStatus).toBe("lost");
    expect(state.events.map((event) => event.eventType)).toEqual([
      "opportunity.marked_lost",
    ]);
    await expectStatsMatchRecount(harness);
  });

  it("counts a side deal's payment and void once each", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const { t, tenantId, closer, admin } = harness;
    const { opportunityId } = await closer.mutation(
      api.opportunities.createManual.createManual,
      {
        clientRequestId: "side-deal",
        newLeadInput: { fullName: "Side Deal", email: "side@example.com" },
      },
    );
    const programId = await t.run(async (ctx) => {
      const users = await ctx.db
        .query("users")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(10);
      const adminUser = users.find((user) => user.role === "tenant_admin")!;
      return await ctx.db.insert("tenantPrograms", {
        tenantId,
        name: "Program",
        normalizedName: "program",
        createdAt: 0,
        createdByUserId: adminUser._id,
        updatedAt: 0,
      });
    });
    await expectStatsMatchRecount(harness);

    const { paymentId } = await closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId,
      amount: 100,
      currency: "USD",
      programId,
      paymentType: "pif",
    });
    expect((await readState(harness, opportunityId)).wonCount).toBe(1);
    await expectStatsMatchRecount(harness);
    await expectPersonCountersMatchRecount(harness);

    await admin.mutation(api.sideDeals.voidPayment.voidPayment, {
      paymentId,
      reason: "refunded",
    });
    const state = await readState(harness, opportunityId);
    expect([state.wonCount, state.lostCount]).toEqual([0, 1]);
    const statusChanges = state.events.filter(
      (event) => event.eventType === "opportunity.status_changed",
    );
    expect(statusChanges.map((event) => [event.fromStatus, event.toStatus])).toEqual([
      ["scheduled", "payment_received"],
      ["payment_received", "lost"],
    ]);
    await expectStatsMatchRecount(harness);
    await expectPersonCountersMatchRecount(harness);
  });
});

describe("rebuildQualificationRows migration", () => {
  it("repairs rows left with an earlier status, and its assert checks them", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    migrationsTest.register(harness.t);
    const { opportunityId, eventId } = await slackOpportunity(harness);
    // A row written before an outcome, as the old write paths left it.
    await harness.t.run(async (ctx) => {
      await forceOpportunityState(ctx, opportunityId, { status: "lost" });
    });

    const run = async (name: string) => {
      await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}` });
      await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
      const [status] = await harness.t.run((ctx) =>
        migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
      );
      return status;
    };

    expect(await run("assertQualificationRowsCurrent")).toMatchObject({
      error: expect.stringContaining("stale qualification row"),
    });
    expect(await run("rebuildQualificationRows")).toMatchObject({ isDone: true });
    const assertion = await run("assertQualificationRowsCurrent");
    expect(assertion?.isDone).toBe(true);
    expect(assertion?.error).toBeUndefined();
    const state = await readState(harness, opportunityId, eventId);
    expect(state.qualificationRow?.opportunityStatus).toBe("lost");
  });
});

describe("status counter repair", () => {
  it("finds drift in tenantStats and resets the status counters from the aggregate", async () => {
    const harness = await bookingHarness();
    await slackOpportunity(harness, "scheduled");
    await slackOpportunity(harness, "lost");
    // A cancel on main that skipped the counters left active one too high.
    await harness.t.run(async (ctx) => {
      await updateTenantStats(ctx, harness.tenantId, { activeOpportunities: 1 });
    });

    const drift = await harness.t.query(
      internal.reporting.verification.verifyTenantStatusCounters,
      { tenantId: harness.tenantId },
    );
    expect(drift).toMatchObject({
      match: false,
      stored: { activeOpportunities: 2, wonDeals: 0, lostDeals: 1 },
      counted: { activeOpportunities: 1, wonDeals: 0, lostDeals: 1 },
    });

    await harness.t.mutation(internal.admin.migrations.repairTenantStatusCounters, {
      tenantId: harness.tenantId,
    });

    expect(
      await harness.t.query(internal.reporting.verification.verifyTenantStatusCounters, {
        tenantId: harness.tenantId,
      }),
    ).toMatchObject({ match: true });
    await expectStatsMatchRecount(harness);
  });
});

describe("seedTenantStatsInternal", () => {
  it("counts converted people as customers, whatever customer rows exist", async () => {
    const harness = await bookingHarness();
    const { tenantId } = harness;
    await harness.t.run(async (ctx) => {
      const person = (status: "active" | "converted" | "merged") =>
        ctx.db.insert("leads", {
          ...qualifiedLifecycle(0), tenantId, status, firstSeenAt: 0, updatedAt: 0,
        });
      await person("converted");
      await person("converted");
      await person("active");
      await person("merged");
    });

    await harness.t.mutation(internal.admin.migrations.seedTenantStatsInternal, { tenantId, totalLeads: 1 });

    const stats = await harness.t.run((ctx) =>
      ctx.db.query("tenantStats").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).unique(),
    );
    expect(stats).toMatchObject({ totalCustomers: 2, totalLeads: 1 });
    await expectPersonCountersMatchRecount(harness);
  });
});
