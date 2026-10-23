import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { rebuildQualificationRow } from "../operations/projections";
import { opportunityByStage } from "../reporting/aggregates";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";
import { stageFields } from "../../tests/dealStageFixtures";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import { migrations } from "../migrations";
import {
  patchOpportunityLifecycle,
  transitionOpportunity,
} from "./opportunityActivity";
import {
  dealStageOf,
  stageForStatus,
  type DealOutcome,
  type DealStage,
  type OpportunityStatus,
} from "../opportunities/stages";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

// A Slack-qualified opportunity at the stage `status` names, with its
// qualification row, counted in the aggregates the way the
// real create paths count it.
async function slackOpportunity(
  harness: Harness,
  status: OpportunityStatus = "scheduled",
  fields: Partial<Doc<"opportunities">> = {},
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
      ...stageFields(status, "slack_qualified"),
      qualifiedBy,
      createdAt: now,
      updatedAt: now,
      ...fields,
    });
    await insertOpportunityAggregate(ctx, opportunityId);
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
    const countAt = async (stage: DealStage, outcome: DealOutcome) =>
      await opportunityByStage.count(ctx, {
        namespace: tenantId,
        bounds: { prefix: [stage, outcome] },
      });
    return {
      opportunity,
      qualificationRow,
      events,
      bookedCount: await countAt("booked", "open"),
      lostCount: await countAt("closed", "lost"),
      wonCount: await countAt("closed", "won"),
    };
  });
}

describe("transitionOpportunity", () => {
  it("moves the stage with its aggregates, event and qualification row, and writes no status", async () => {
    const harness = await bookingHarness();
    const { opportunityId, closerId, eventId } = await slackOpportunity(harness);

    await harness.t.run(async (ctx) => {
      await transitionOpportunity(ctx, opportunityId, {
        to: { stage: "closed", outcome: "lost" },
        fields: { lostAt: 1_000, lostReason: "budget", lostByUserId: closerId },
        source: "closer",
        actorUserId: closerId,
        reason: "budget",
      });
    });

    const state = await readState(harness, opportunityId, eventId);
    expect(state.opportunity).toMatchObject({
      stage: "closed",
      outcome: "lost",
      lostReason: "budget",
      lostAt: 1_000,
    });
    expect(state.qualificationRow).toMatchObject({
      dealStage: "closed",
      dealOutcome: "lost",
    });
    // A loss keeps its event type; from PR 8 the event holds the stages, with
    // the outcomes in its metadata.
    expect(state.events).toEqual([
      expect.objectContaining({
        eventType: "opportunity.marked_lost",
        fromStatus: "booked",
        toStatus: "closed",
        actorUserId: closerId,
        reason: "budget",
        metadata: JSON.stringify({ fromOutcome: "open", toOutcome: "lost" }),
      }),
    ]);
    expect([state.bookedCount, state.lostCount]).toEqual([0, 1]);
  });

  it("emits opportunity.stage_changed for a move that isn't a loss", async () => {
    const harness = await bookingHarness();
    const { opportunityId } = await slackOpportunity(harness);

    await harness.t.run(async (ctx) => {
      await transitionOpportunity(ctx, opportunityId, {
        to: { stage: "closed", outcome: "won" },
        source: "closer",
        metadata: { paymentId: "p1" },
      });
    });

    const state = await readState(harness, opportunityId);
    expect(state.opportunity).toMatchObject({ stage: "closed", outcome: "won" });
    expect(state.events).toEqual([
      expect.objectContaining({
        eventType: "opportunity.stage_changed",
        fromStatus: "booked",
        toStatus: "closed",
        metadata: JSON.stringify({ paymentId: "p1", fromOutcome: "open", toOutcome: "won" }),
      }),
    ]);
    expect(state.wonCount).toBe(1);
  });

  it.each([
    ["a person's loss to Booked", "lost", { lostReason: "budget" }, { stage: "booked" }],
    ["Closed won to lost", "payment_received", {}, { stage: "closed", outcome: "lost" }],
    ["a no-show to Follow-up", "no_show", { lostReason: "no_show" }, { stage: "follow_up" }],
    ["a no-show to Booked", "no_show", { lostReason: "no_show" }, { stage: "booked" }],
    ["Booked to Booked", "scheduled", {}, { stage: "booked" }],
  ] as const)(
    "rejects %s without a named exception and writes nothing",
    async (_label, from, fields, to) => {
      const harness = await bookingHarness();
      const { opportunityId } = await slackOpportunity(harness, from, fields);
      const before = await readState(harness, opportunityId);

      await expect(
        harness.t.run(async (ctx) => {
          await transitionOpportunity(ctx, opportunityId, { to, source: "system" });
        }),
      ).rejects.toThrow("Cannot move deal from");

      const after = await readState(harness, opportunityId);
      expect(after.opportunity).toEqual(before.opportunity);
      expect(after.events).toHaveLength(0);
    },
  );

  it.each([
    ["payment_received", {}, { stage: "closed", outcome: "lost" }, "payment_voided", "lost"],
    ["lost", { lostReason: "stale" }, { stage: "booked" }, "slack_stale_rejoin", "scheduled"],
    ["no_show", { lostReason: "no_show" }, { stage: "follow_up" }, "missed_meeting_next_step", "follow_up_scheduled"],
    ["canceled", { lostReason: "canceled" }, { stage: "follow_up" }, "missed_meeting_next_step", "follow_up_scheduled"],
    ["no_show", { lostReason: "no_show" }, { stage: "booked" }, "no_show_withdrawn", "scheduled"],
  ] as const)(
    "allows %s -> %j only for the %s exception, to the stage PR 7's %s names",
    async (from, fields, to, exception, status) => {
      const harness = await bookingHarness();
      const { opportunityId } = await slackOpportunity(harness, from, { ...fields, lostAt: 500 });

      await harness.t.run(async (ctx) => {
        await transitionOpportunity(ctx, opportunityId, { to, source: "system", exception });
      });

      const { opportunity } = await readState(harness, opportunityId);
      expect(dealStageOf(opportunity!)).toEqual(stageForStatus(status, "slack_qualified"));
      // Reopening clears the loss it reopened.
      if (to.stage !== "closed") {
        expect([opportunity?.lostReason, opportunity?.lostAt, opportunity?.lostByUserId]).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
      }
    },
  );

  it("doesn't let one exception unlock another's moves", async () => {
    const harness = await bookingHarness();
    const { opportunityId } = await slackOpportunity(harness, "payment_received");

    await expect(
      harness.t.run(async (ctx) => {
        await transitionOpportunity(ctx, opportunityId, {
          to: { stage: "closed", outcome: "lost" },
          source: "pipeline",
          exception: "no_show_withdrawn",
        });
      }),
    ).rejects.toThrow('Cannot move deal from "closed won" to "closed lost" with "no_show_withdrawn"');
  });
});

describe("patchOpportunityLifecycle", () => {
  it("re-keys the stage aggregate and qualification row when the closer changes", async () => {
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
        await opportunityByStage.count(ctx, {
          namespace: harness.tenantId,
          bounds: { prefix: ["booked", "open", userId] },
        });
      return [await count(closerId), await count(otherCloserId)];
    });
    expect(counts).toEqual([0, 1]);
    const state = await readState(harness, opportunityId, eventId);
    expect(state.qualificationRow?.assignedCloserId).toBe(otherCloserId);
  });

  it("refuses a stage change", async () => {
    const harness = await bookingHarness();
    const { opportunityId } = await slackOpportunity(harness);

    await expect(
      harness.t.run(async (ctx) => {
        // @ts-expect-error the stage is not a patchable field
        await patchOpportunityLifecycle(ctx, opportunityId, { stage: "closed" });
      }),
    ).rejects.toThrow("Use transitionOpportunity");
  });
});

describe("stage changes through the public mutations", () => {
  it("keeps the qualification row current when a closer marks a deal lost", async () => {
    const harness = await bookingHarness();
    const { opportunityId, eventId } = await slackOpportunity(harness);

    await harness.closer.mutation(api.closer.meetingActions.markAsLost, {
      opportunityId,
      reason: "not a fit",
    });

    const state = await readState(harness, opportunityId, eventId);
    expect(state.qualificationRow).toMatchObject({ dealStage: "closed", dealOutcome: "lost" });
    expect(state.events.map((event) => event.eventType)).toEqual([
      "opportunity.marked_lost",
    ]);
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

    const { paymentId } = await closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId,
      amount: 100,
      currency: "USD",
      programId,
      paymentType: "pif",
    });
    expect((await readState(harness, opportunityId)).wonCount).toBe(1);
    const paymentState = () => t.run(async (ctx) => {
      const payment = await ctx.db.get("paymentRecords", paymentId);
      const opportunity = await ctx.db.get("opportunities", opportunityId);
      const lead = await ctx.db.get("leads", opportunity!.leadId);
      return { payment, lead };
    });
    expect(await paymentState()).toMatchObject({
      payment: { amountMinor: 10_000, status: "recorded", opportunityId },
      lead: { status: "converted" },
    });

    await admin.mutation(api.sideDeals.voidPayment.voidPayment, {
      paymentId,
      reason: "refunded",
    });
    const state = await readState(harness, opportunityId);
    expect([state.wonCount, state.lostCount]).toEqual([0, 1]);
    // From PR 8: the stages, with the outcomes in the metadata; the void is
    // a loss, so it is `opportunity.marked_lost`.
    const moves = state.events.filter((event) => event.eventType !== "opportunity.created");
    expect(
      moves.map((event) => {
        const { fromOutcome, toOutcome } = JSON.parse(event.metadata!) as Record<string, string>;
        return [event.eventType, `${event.fromStatus}/${fromOutcome}`, `${event.toStatus}/${toOutcome}`];
      }),
    ).toEqual([
      ["opportunity.stage_changed", "call_held/open", "closed/won"],
      ["opportunity.marked_lost", "closed/won", "closed/lost"],
    ]);
    expect(state.opportunity).toMatchObject({ stage: "closed", outcome: "lost" });
    expect(await paymentState()).toMatchObject({
      payment: { status: "disputed" },
      lead: { status: "active" },
    });
  });
});

describe("rebuildQualificationRows migration", () => {
  it("repairs rows left with an earlier stage, and its assert checks them", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    migrationsTest.register(harness.t);
    const { opportunityId, eventId } = await slackOpportunity(harness);
    // A row written before an outcome, as the old write paths left it.
    await harness.t.run(async (ctx) => {
      await forceOpportunityState(ctx, opportunityId, { stage: "closed", outcome: "lost" });
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
    expect(state.qualificationRow).toMatchObject({ dealStage: "closed", dealOutcome: "lost" });
  });
});
