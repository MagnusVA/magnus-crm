import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  patchOpportunityLifecycle,
  transitionOpportunity,
  type OpportunityTransitionException,
} from "../lib/opportunityActivity";
import {
  VALID_TRANSITIONS,
  type OpportunityStatus,
} from "../lib/statusTransitions";
import { deleteOpportunityAggregate } from "../reporting/writeHooks";
import { bookingPayload } from "../../tests/bookingHarness";
import {
  countAtStage,
  harnessCloserId,
  insertDeal,
  type DealFields,
} from "../../tests/dealStageFixtures";
import {
  book,
  enrollmentHarness,
  sideDeal,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";
import { stageForStatus, type DealSource } from "./stages";

// The dual write (docs/plans/phase-5-deal-status.md §3.1, §4.2, §4.4):
// every status write also writes the deal's stage and outcome, and a missed
// meeting writes its loss.

afterEach(() => vi.useRealTimers());

const NOW = Date.parse("2026-10-20T12:00:00Z");

// Every move the state machine allows, and each named exception's.
const MOVES: [OpportunityStatus, OpportunityStatus, OpportunityTransitionException?][] = [
  ...(Object.entries(VALID_TRANSITIONS) as [OpportunityStatus, OpportunityStatus[]][]).flatMap(
    ([from, tos]) => tos.map((to): [OpportunityStatus, OpportunityStatus] => [from, to]),
  ),
  ["no_show", "canceled", "calendly_webhook"],
  ["canceled", "no_show", "calendly_webhook"],
  ["payment_received", "lost", "payment_voided"],
  ["lost", "scheduled", "slack_stale_rejoin"],
];

function sourceFor(status: OpportunityStatus): DealSource {
  return status === "qualified_pending" ? "slack_qualified" : "calendly";
}

async function readDeal(harness: EnrollmentHarness, opportunityId: Id<"opportunities">) {
  return (await harness.t.run((ctx) => ctx.db.get("opportunities", opportunityId)))!;
}

async function move(
  harness: EnrollmentHarness,
  opportunityId: Id<"opportunities">,
  to: OpportunityStatus,
  options: Partial<Parameters<typeof transitionOpportunity>[2]> = {},
) {
  await harness.t.run((ctx) =>
    transitionOpportunity(ctx, opportunityId, { to, source: "system", ...options }),
  );
  return await readDeal(harness, opportunityId);
}

async function dealAt(
  harness: EnrollmentHarness,
  status: OpportunityStatus,
  options: { source?: DealSource; written?: boolean; fields?: DealFields } = {},
) {
  return await harness.t.run(async (ctx) =>
    insertDeal(ctx, {
      tenantId: harness.tenantId,
      status,
      source: options.source ?? sourceFor(status),
      written: options.written,
      fields: { assignedCloserId: await harnessCloserId(ctx), ...options.fields },
    }),
  );
}

describe("transitionOpportunity writes the stage and outcome", () => {
  it("on every move, from the status it writes", async () => {
    const harness = await enrollmentHarness();
    for (const [from, to, exception] of MOVES) {
      const opportunityId = await dealAt(harness, from);
      const deal = await move(harness, opportunityId, to, { exception });
      expect({ from, to, status: deal.status, stage: deal.stage, outcome: deal.outcome }).toEqual({
        from,
        to,
        status: to,
        ...stageForStatus(to, sourceFor(from)),
      });
    }
  });

  it("keeps a side deal at Call held while it is scheduled", async () => {
    const harness = await enrollmentHarness();
    const followUp = await dealAt(harness, "scheduled", { source: "side_deal" });
    expect(await readDeal(harness, followUp)).toMatchObject({ stage: "call_held", outcome: "open" });
    expect(await move(harness, followUp, "follow_up_scheduled")).toMatchObject({
      stage: "follow_up",
      outcome: "open",
    });
    expect(await move(harness, followUp, "scheduled")).toMatchObject({
      stage: "call_held",
      outcome: "open",
    });
    expect(await move(harness, followUp, "payment_received")).toMatchObject({
      stage: "closed",
      outcome: "won",
    });
  });

  it("moves the deal's opportunityByStage entry, by stage, outcome and closer", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");
    const counts = () =>
      harness.t.run(async (ctx) => {
        const closerId = await harnessCloserId(ctx);
        return {
          booked: await countAtStage(ctx, harness.tenantId, "booked", "open", closerId),
          lost: await countAtStage(ctx, harness.tenantId, "closed", "lost", closerId),
          won: await countAtStage(ctx, harness.tenantId, "closed", "won"),
        };
      });
    expect(await counts()).toEqual({ booked: 1, lost: 0, won: 0 });

    await move(harness, opportunityId, "no_show", { fields: { noShowAt: NOW } });
    expect(await counts()).toEqual({ booked: 0, lost: 1, won: 0 });

    await move(harness, opportunityId, "scheduled");
    await move(harness, opportunityId, "payment_received");
    expect(await counts()).toEqual({ booked: 0, lost: 0, won: 1 });
  });

  it("enters a deal from before the widen into opportunityByStage on its first move", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled", { written: false });
    const before = await readDeal(harness, opportunityId);
    expect([before.stage, before.outcome]).toEqual([undefined, undefined]);
    const count = (stage: "booked" | "closed", outcome: "open" | "lost") =>
      harness.t.run((ctx) => countAtStage(ctx, harness.tenantId, stage, outcome));
    expect(await count("booked", "open")).toBe(0);

    const deal = await move(harness, opportunityId, "canceled", { fields: { canceledAt: NOW } });

    expect(deal).toMatchObject({ stage: "closed", outcome: "lost" });
    expect([await count("booked", "open"), await count("closed", "lost")]).toEqual([0, 1]);
  });

  it("enters a deal from before the widen when another key field changes, and deletes one never entered", async () => {
    const harness = await enrollmentHarness();
    const reassigned = await dealAt(harness, "follow_up_scheduled", { written: false });
    const deleted = await dealAt(harness, "lost", { written: false });

    await harness.t.run(async (ctx) => {
      await patchOpportunityLifecycle(ctx, reassigned, { assignedCloserId: undefined });
      const doc = (await ctx.db.get("opportunities", deleted))!;
      await deleteOpportunityAggregate(ctx, doc);
    });

    expect(
      await harness.t.run((ctx) => countAtStage(ctx, harness.tenantId, "follow_up", "open", "" as Id<"users">)),
    ).toBe(1);
    expect(await harness.t.run((ctx) => countAtStage(ctx, harness.tenantId, "closed", "lost"))).toBe(0);
  });
});

describe("a missed meeting writes its loss", () => {
  it("writes the canceled code with the cancellation time", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");

    const deal = await move(harness, opportunityId, "canceled", {
      fields: { canceledAt: NOW - 5_000, updatedAt: NOW },
      occurredAt: NOW,
    });

    expect(deal).toMatchObject({ lostReason: "canceled", lostAt: NOW - 5_000 });
    expect(deal.lostByUserId).toBeUndefined();
  });

  it("writes the no_show code with the no-show time", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");

    const deal = await move(harness, opportunityId, "no_show", {
      fields: { noShowAt: NOW - 7_000, updatedAt: NOW },
      occurredAt: NOW,
    });

    expect(deal).toMatchObject({ lostReason: "no_show", lostAt: NOW - 7_000 });
  });

  it("takes the move's time when the caller gives no cancellation time, then the clock", async () => {
    const harness = await enrollmentHarness();
    const withTime = await dealAt(harness, "scheduled");
    const withoutTime = await dealAt(harness, "scheduled");

    expect(await move(harness, withTime, "canceled", { occurredAt: NOW - 3_000 })).toMatchObject({
      lostReason: "canceled",
      lostAt: NOW - 3_000,
    });
    expect(await move(harness, withoutTime, "canceled")).toMatchObject({
      lostReason: "canceled",
      lostAt: NOW,
    });
  });

  it("rewrites the code and time when Calendly moves between no-show and canceled", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");
    await move(harness, opportunityId, "no_show", { fields: { noShowAt: NOW - 9_000 } });

    expect(
      await move(harness, opportunityId, "canceled", {
        fields: { canceledAt: NOW - 4_000, noShowAt: undefined },
        exception: "calendly_webhook",
      }),
    ).toMatchObject({ stage: "closed", outcome: "lost", lostReason: "canceled", lostAt: NOW - 4_000 });
    expect(
      await move(harness, opportunityId, "no_show", {
        fields: { noShowAt: NOW - 1_000 },
        exception: "calendly_webhook",
      }),
    ).toMatchObject({ stage: "closed", outcome: "lost", lostReason: "no_show", lostAt: NOW - 1_000 });
  });

  it.each([
    ["canceled", "follow_up_scheduled"],
    ["canceled", "scheduled"],
    ["no_show", "follow_up_scheduled"],
    ["no_show", "reschedule_link_sent"],
    ["no_show", "scheduled"],
  ] as const)("clears the loss when the deal goes on from %s to %s", async (from, to) => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");
    await move(harness, opportunityId, from, {
      fields: from === "canceled" ? { canceledAt: NOW } : { noShowAt: NOW },
    });

    const deal = await move(harness, opportunityId, to);

    expect(deal).toMatchObject({ status: to, outcome: "open" });
    expect([deal.lostReason, deal.lostAt, deal.lostByUserId]).toEqual([undefined, undefined, undefined]);
  });

  it("keeps the reason, time and person of a loss a closer records", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");

    const deal = await move(harness, opportunityId, "lost", {
      fields: { lostAt: NOW - 2_000, lostReason: "budget", lostByUserId: harness.closerId },
      eventType: "opportunity.marked_lost",
    });

    expect(deal).toMatchObject({
      stage: "closed",
      outcome: "lost",
      lostAt: NOW - 2_000,
      lostReason: "budget",
      lostByUserId: harness.closerId,
    });
  });

  it("leaves the caller's loss fields alone on a move that isn't a missed meeting", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "lost", {
      source: "slack_qualified",
      fields: { lostReason: "stale", lostAt: NOW - 1_000 },
    });

    // The Slack stale rejoin clears its own loss.
    const deal = await move(harness, opportunityId, "scheduled", {
      fields: { lostAt: undefined, lostReason: undefined, lostByUserId: undefined },
      exception: "slack_stale_rejoin",
    });
    expect(deal).toMatchObject({ stage: "booked", outcome: "open" });
    expect([deal.lostReason, deal.lostAt]).toEqual([undefined, undefined]);
  });
});

describe("patchOpportunityLifecycle", () => {
  it("refuses a stage or an outcome", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");

    await expect(
      harness.t.run(async (ctx) => {
        // @ts-expect-error stage is not a patchable field
        await patchOpportunityLifecycle(ctx, opportunityId, { stage: "closed" });
      }),
    ).rejects.toThrow("Use transitionOpportunity");
    await expect(
      harness.t.run(async (ctx) => {
        // @ts-expect-error outcome is not a patchable field
        await patchOpportunityLifecycle(ctx, opportunityId, { outcome: "won" });
      }),
    ).rejects.toThrow("Use transitionOpportunity");
    expect(await readDeal(harness, opportunityId)).toMatchObject({ stage: "booked", outcome: "open" });
  });
});

describe("the inserts write the stage and outcome", () => {
  it("a cold Calendly booking starts Booked", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId } = await book(harness, "cold");

    expect(await readDeal(harness, opportunityId)).toMatchObject({
      status: "scheduled",
      stage: "booked",
      outcome: "open",
    });
    expect(
      await harness.t.run((ctx) => countAtStage(ctx, harness.tenantId, "booked", "open", harness.closerId)),
    ).toBe(1);
  });

  it("a Slack qualification starts Qualified", async () => {
    const harness = await enrollmentHarness();
    const installationId = await harness.t.run((ctx) =>
      ctx.db.insert("slackInstallations", {
        tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
        botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
        notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
        installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
      }),
    );

    const result = await harness.t.mutation(internal.slack.createQualifiedLead.create, {
      tenantId: harness.tenantId,
      installationId,
      fullName: "Slack Lead",
      handle: "@slack.lead",
      country: "Mexico",
      leadType: "pt",
      qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: NOW },
    });

    expect(result).toMatchObject({ kind: "created" });
    const deals = await harness.t.run((ctx) =>
      ctx.db
        .query("opportunities")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", harness.tenantId))
        .take(10),
    );
    expect(deals.map((deal) => [deal.status, deal.stage, deal.outcome])).toEqual([
      ["qualified_pending", "qualified", "open"],
    ]);
    expect(await harness.t.run((ctx) => countAtStage(ctx, harness.tenantId, "qualified", "open"))).toBe(1);
  });

  it("a side deal starts at Call held", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId } = await sideDeal(harness, "side", { email: "side@example.com" });

    expect(await readDeal(harness, opportunityId)).toMatchObject({
      status: "scheduled",
      stage: "call_held",
      outcome: "open",
    });
    expect(await harness.t.run((ctx) => countAtStage(ctx, harness.tenantId, "call_held", "open"))).toBe(1);
  });
});

describe("the public write paths", () => {
  it("a closer's no-show closes the deal with its code, and a reschedule link reopens it", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId, meetingId } = await book(harness, "no-show");
    await harness.t.run((ctx) =>
      ctx.db.patch("users", harness.closerId, { personalEventTypeUri: "https://calendly.com/closer/test" }),
    );

    await harness.closer.mutation(api.closer.noShowActions.markNoShow, {
      meetingId,
      reason: "no_response",
    });
    const missed = await readDeal(harness, opportunityId);
    expect(missed).toMatchObject({ status: "no_show", stage: "closed", outcome: "lost", lostReason: "no_show" });
    expect(missed.lostAt).toBeDefined();
    expect(missed.lostAt).toBe(missed.noShowAt);
    expect(missed.lostByUserId).toBeUndefined();

    await harness.closer.mutation(api.closer.noShowActions.createNoShowRescheduleLink, {
      opportunityId,
      meetingId,
    });
    const reopened = await readDeal(harness, opportunityId);
    expect(reopened).toMatchObject({ status: "reschedule_link_sent", stage: "follow_up", outcome: "open" });
    expect([reopened.lostReason, reopened.lostAt]).toEqual([undefined, undefined]);
  });

  it("a Calendly cancellation closes the deal at the time Calendly sent it", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId } = await book(harness, "canceled");
    const payload = bookingPayload("canceled");

    await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId: harness.tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.canceled",
      payload: JSON.stringify({ created_at: "2026-09-30T18:00:00Z", payload }),
    });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

    const deal = await readDeal(harness, opportunityId);
    expect(deal).toMatchObject({ status: "canceled", stage: "closed", outcome: "lost", lostReason: "canceled" });
    expect(deal.lostAt).toBe(Date.parse("2026-09-30T18:00:00Z"));
    expect(deal.lostAt).toBe(deal.canceledAt);
    expect(deal.lostByUserId).toBeUndefined();
  });
});
