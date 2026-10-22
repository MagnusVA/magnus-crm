import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  changeMissedMeetingLoss,
  missedMeetingLoss,
  patchOpportunityLifecycle,
  syncLegacyStatus,
  transitionOpportunity,
} from "../lib/opportunityActivity";
import { opportunityByStatus } from "../reporting/aggregates";
import { deleteOpportunityAggregate } from "../reporting/writeHooks";
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
import {
  dealEvents,
  expectStatusCopiesMatch,
  pr7Moves,
  storedAndRebuiltStatus,
} from "../../tests/stageMachineFixtures";
import { missedMeetingLossReason, stageForStatus, type DealSource, type DealTarget, type OpportunityStatus, type StageTransitionException } from "./stages";

// From PR 8 the transition takes a stage and the stage machine checks it
// (docs/plans/phase-5-deal-status.md §4.4); the status is still written, as
// `legacyStatus` of the deal it leaves, with `opportunityByStatus` and the
// tenant counters, so a revert to PR 7 finds what PR 7 would have written
// (§9, §12). Every move emits a deal event in the new form (§4.7).

afterEach(() => vi.useRealTimers());

const NOW = Date.parse("2026-10-20T12:00:00Z");

function sourceFor(status: OpportunityStatus): DealSource {
  return status === "qualified_pending" || status === "lost" ? "slack_qualified" : "calendly";
}

async function readDeal(harness: EnrollmentHarness, opportunityId: Id<"opportunities">) {
  return (await harness.t.run((ctx) => ctx.db.get("opportunities", opportunityId)))!;
}

async function move(
  harness: EnrollmentHarness,
  opportunityId: Id<"opportunities">,
  to: DealTarget,
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
  const reason = missedMeetingLossReason(status);
  return await harness.t.run(async (ctx) =>
    insertDeal(ctx, {
      tenantId: harness.tenantId,
      status,
      source: options.source ?? sourceFor(status),
      written: options.written,
      fields: {
        assignedCloserId: await harnessCloserId(ctx),
        ...(reason ? { lostReason: reason, lostAt: 900 } : {}),
        ...(status === "lost" ? { lostReason: "stale", lostAt: 900 } : {}),
        ...options.fields,
      },
    }),
  );
}

async function insertRescheduleLink(harness: EnrollmentHarness, opportunityId: Id<"opportunities">) {
  return await harness.t.run(async (ctx) => {
    const deal = (await ctx.db.get("opportunities", opportunityId))!;
    return await ctx.db.insert("followUps", {
      tenantId: deal.tenantId,
      opportunityId,
      leadId: deal.leadId,
      closerId: await harnessCloserId(ctx),
      type: "scheduling_link",
      reason: "no_show_follow_up",
      status: "pending",
      createdAt: NOW,
    });
  });
}

// The stage target and exception of each PR 7 move (plan §5, "From PR 8").
const EXCEPTION_FOR: Partial<Record<string, StageTransitionException>> = {
  "lost->scheduled": "slack_stale_rejoin",
  "payment_received->lost": "payment_voided",
  "no_show->follow_up_scheduled": "missed_meeting_next_step",
  "no_show->reschedule_link_sent": "missed_meeting_next_step",
  "canceled->follow_up_scheduled": "missed_meeting_next_step",
  "no_show->scheduled": "no_show_withdrawn",
};

function targetFor(status: OpportunityStatus, source: DealSource): DealTarget {
  const { stage, outcome } = stageForStatus(status, source);
  return stage === "closed" ? { stage, outcome: outcome as "won" | "lost" } : { stage };
}

describe("the revert property: every move stores the status PR 7 wrote", () => {
  // The Calendly flip between no-show and canceled is no move from PR 8,
  // and canceled -> scheduled went with the 14-day join in PR 2.
  const MOVES = pr7Moves().filter(
    ([from, to, exception]) => exception !== "calendly_webhook" && !(from === "canceled" && to === "scheduled"),
  );

  it.each(MOVES)("%s -> %s (%s)", async (from, to) => {
    const harness = await enrollmentHarness();
    const source = sourceFor(from);
    const opportunityId = await dealAt(harness, from);
    // The reschedule link actions write the link before the move.
    if (to === "reschedule_link_sent") await insertRescheduleLink(harness, opportunityId);
    const reason = missedMeetingLossReason(to);

    const deal = await move(harness, opportunityId, targetFor(to, source), {
      exception: EXCEPTION_FOR[`${from}->${to}`],
      fields: reason ? missedMeetingLoss(reason, NOW) : {},
      occurredAt: NOW,
    });

    expect({ status: deal.status, stage: deal.stage, outcome: deal.outcome }).toEqual({
      status: to,
      ...stageForStatus(to, source),
    });
    expect(await harness.t.run((ctx) => storedAndRebuiltStatus(ctx, opportunityId))).toEqual({
      stored: to,
      rebuilt: to,
    });
    await harness.t.run((ctx) => expectStatusCopiesMatch(ctx, harness.tenantId));
  });

  it("moves the opportunityByStatus entry, and enters a deal it never held", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");
    // As a revert after PR 9's clear finds a deal: not in the status aggregate.
    await harness.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", opportunityId))!;
      await opportunityByStatus.delete(ctx, deal);
    });
    const count = (status: OpportunityStatus) =>
      harness.t.run((ctx) =>
        opportunityByStatus.count(ctx, { namespace: harness.tenantId, bounds: { prefix: [status] } }),
      );
    expect(await count("scheduled")).toBe(0);

    await move(harness, opportunityId, { stage: "follow_up" });

    expect([await count("scheduled"), await count("follow_up_scheduled")]).toEqual([0, 1]);
    await move(harness, opportunityId, { stage: "closed", outcome: "won" });
    expect([await count("follow_up_scheduled"), await count("payment_received")]).toEqual([0, 1]);
  });

  it("writes a status on a deal that has none, as a revert after PR 9's clear finds it", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");
    await harness.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", opportunityId))!;
      await opportunityByStatus.delete(ctx, deal);
      // eslint-disable-next-line no-restricted-syntax -- the fixture is PR 9's clear
      await ctx.db.patch("opportunities", opportunityId, { status: undefined });
      await ctx.db.patch("tenantStats", (await ctx.db.query("tenantStats").first())!._id, {
        activeOpportunities: 0,
      });
    });

    const deal = await move(harness, opportunityId, { stage: "closed", outcome: "won" });

    expect(deal.status).toBe("payment_received");
    await harness.t.run((ctx) => expectStatusCopiesMatch(ctx, harness.tenantId));
  });
});

describe("transitionOpportunity", () => {
  it("emits the deal event in the new form: stages, with the outcomes in the metadata", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");

    await move(harness, opportunityId, { stage: "closed", outcome: "lost" }, {
      fields: missedMeetingLoss("no_show", NOW - 1_000),
      occurredAt: NOW,
    });
    await move(harness, opportunityId, { stage: "follow_up" }, {
      exception: "missed_meeting_next_step",
      metadata: { followUpId: "f1" },
      occurredAt: NOW + 1,
    });
    await move(harness, opportunityId, { stage: "closed", outcome: "won" }, { occurredAt: NOW + 2 });

    expect(await harness.t.run((ctx) => dealEvents(ctx, harness.tenantId, opportunityId))).toEqual([
      {
        // A loss keeps its type, and gives its reason.
        eventType: "opportunity.marked_lost",
        fromStatus: "booked",
        toStatus: "closed",
        reason: "no_show",
        metadata: { fromOutcome: "open", toOutcome: "lost" },
      },
      {
        eventType: "opportunity.stage_changed",
        fromStatus: "closed",
        toStatus: "follow_up",
        reason: undefined,
        metadata: { followUpId: "f1", fromOutcome: "lost", toOutcome: "open" },
      },
      {
        eventType: "opportunity.stage_changed",
        fromStatus: "follow_up",
        toStatus: "closed",
        reason: undefined,
        metadata: { fromOutcome: "open", toOutcome: "won" },
      },
    ]);
  });

  it("refuses a move the stage machine forbids, and writes nothing", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "payment_received");
    const before = await readDeal(harness, opportunityId);

    await expect(
      harness.t.run((ctx) =>
        transitionOpportunity(ctx, opportunityId, { to: { stage: "booked" }, source: "system" }),
      ),
    ).rejects.toThrow('Cannot move deal from "closed won" to "booked"');

    expect(await readDeal(harness, opportunityId)).toEqual(before);
    expect(await harness.t.run((ctx) => dealEvents(ctx, harness.tenantId, opportunityId))).toEqual([]);
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

    await move(harness, opportunityId, { stage: "closed", outcome: "lost" }, {
      fields: missedMeetingLoss("no_show", NOW),
    });
    expect(await counts()).toEqual({ booked: 0, lost: 1, won: 0 });

    await move(harness, opportunityId, { stage: "booked" }, { exception: "no_show_withdrawn" });
    await move(harness, opportunityId, { stage: "closed", outcome: "won" });
    expect(await counts()).toEqual({ booked: 0, lost: 0, won: 1 });
  });

  it("enters a deal from before the widen into opportunityByStage on its first move", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled", { written: false });
    const count = (stage: "booked" | "closed", outcome: "open" | "lost") =>
      harness.t.run((ctx) => countAtStage(ctx, harness.tenantId, stage, outcome));
    expect(await count("booked", "open")).toBe(0);

    const deal = await move(harness, opportunityId, { stage: "closed", outcome: "lost" }, {
      fields: missedMeetingLoss("canceled", NOW),
    });

    expect(deal).toMatchObject({ stage: "closed", outcome: "lost", status: "canceled" });
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

  it("keeps a side deal at Call held, and a booking that joins it after a follow-up moves it to Booked", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled", { source: "side_deal" });
    expect(await readDeal(harness, opportunityId)).toMatchObject({ stage: "call_held", outcome: "open" });

    expect(await move(harness, opportunityId, { stage: "follow_up" })).toMatchObject({
      stage: "follow_up",
      status: "follow_up_scheduled",
    });
    // The mapping kept it at Call held before PR 8; the status is the same.
    expect(await move(harness, opportunityId, { stage: "booked" })).toMatchObject({
      stage: "booked",
      outcome: "open",
      status: "scheduled",
    });
  });
});

describe("the loss", () => {
  it("writes the caller's loss on a move to Closed lost, at the move's time when it gives none", async () => {
    const harness = await enrollmentHarness();
    const withTime = await dealAt(harness, "scheduled");
    const withoutTime = await dealAt(harness, "scheduled");

    expect(
      await move(harness, withTime, { stage: "closed", outcome: "lost" }, {
        fields: { lostReason: "canceled" },
        occurredAt: NOW - 3_000,
      }),
    ).toMatchObject({ lostReason: "canceled", lostAt: NOW - 3_000, status: "canceled" });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(
      await move(harness, withoutTime, { stage: "closed", outcome: "lost" }, { fields: { lostReason: "no_show" } }),
    ).toMatchObject({ lostReason: "no_show", lostAt: NOW, status: "no_show" });
  });

  it("keeps the reason, time and person of a loss a person records, whose status is lost whatever its text", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");

    const deal = await move(harness, opportunityId, { stage: "closed", outcome: "lost" }, {
      fields: { lostAt: NOW - 2_000, lostReason: "no_show", lostByUserId: harness.closerId },
    });

    expect(deal).toMatchObject({
      stage: "closed",
      outcome: "lost",
      status: "lost",
      lostAt: NOW - 2_000,
      lostReason: "no_show",
      lostByUserId: harness.closerId,
    });
  });

  it.each([
    ["no_show", { stage: "follow_up" }, "missed_meeting_next_step"],
    ["canceled", { stage: "follow_up" }, "missed_meeting_next_step"],
    ["no_show", { stage: "booked" }, "no_show_withdrawn"],
    ["lost", { stage: "booked" }, "slack_stale_rejoin"],
  ] as const)("clears the loss when a %s deal reopens at %j", async (from, to, exception) => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, from);

    const deal = await move(harness, opportunityId, to, { exception });

    expect(deal).toMatchObject({ outcome: "open" });
    expect([deal.lostReason, deal.lostAt, deal.lostByUserId]).toEqual([undefined, undefined, undefined]);
  });

  it("doesn't reopen a person's loss with the text 'stale'", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "lost", { fields: { lostByUserId: harness.closerId } });

    await expect(
      harness.t.run((ctx) =>
        transitionOpportunity(ctx, opportunityId, {
          to: { stage: "booked" },
          exception: "slack_stale_rejoin",
          source: "pipeline",
        }),
      ),
    ).rejects.toThrow('Cannot move deal from "closed lost" to "booked" with "slack_stale_rejoin"');
  });
});

describe("changeMissedMeetingLoss: Calendly's flip between no-show and canceled", () => {
  it("changes the reason, time and status in place, and records a closed -> closed deal event", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "no_show");

    await harness.t.run((ctx) =>
      changeMissedMeetingLoss(ctx, opportunityId, {
        reason: "canceled",
        at: NOW - 4_000,
        fields: { canceledAt: NOW - 4_000, noShowAt: undefined, updatedAt: NOW },
        source: "pipeline",
        occurredAt: NOW - 4_000,
      }),
    );

    expect(await readDeal(harness, opportunityId)).toMatchObject({
      stage: "closed",
      outcome: "lost",
      status: "canceled",
      lostReason: "canceled",
      lostAt: NOW - 4_000,
      canceledAt: NOW - 4_000,
      updatedAt: NOW,
    });
    expect(await harness.t.run((ctx) => dealEvents(ctx, harness.tenantId, opportunityId))).toEqual([
      {
        eventType: "opportunity.stage_changed",
        fromStatus: "closed",
        toStatus: "closed",
        reason: "canceled",
        metadata: { fromOutcome: "lost", toOutcome: "lost" },
      },
    ]);
    await harness.t.run((ctx) => expectStatusCopiesMatch(ctx, harness.tenantId));
  });

  it.each([
    ["a person's loss", "lost", { lostReason: "budget", lostByUserId: "x" }],
    ["the same reason", "no_show", {}],
    ["an open deal", "scheduled", {}],
  ] as const)("refuses %s", async (_label, status, fields) => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, status, {
      fields: "lostByUserId" in fields ? { ...fields, lostByUserId: harness.closerId } : fields,
    });

    await expect(
      harness.t.run((ctx) =>
        changeMissedMeetingLoss(ctx, opportunityId, {
          reason: "no_show",
          at: NOW,
          fields: {},
          source: "pipeline",
        }),
      ),
    ).rejects.toThrow("Cannot change a missed meeting's loss");
  });
});

describe("the status follows a change that isn't a stage move", () => {
  it("syncLegacyStatus rewrites a Follow-up deal's status when a reschedule link comes and goes, keeping updatedAt", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "follow_up_scheduled", { fields: { updatedAt: 1_234 } });

    const linkId = await insertRescheduleLink(harness, opportunityId);
    await harness.t.run((ctx) => syncLegacyStatus(ctx, opportunityId));
    expect(await readDeal(harness, opportunityId)).toMatchObject({
      status: "reschedule_link_sent",
      updatedAt: 1_234,
    });
    await harness.t.run((ctx) => expectStatusCopiesMatch(ctx, harness.tenantId));

    await harness.t.run((ctx) => ctx.db.patch("followUps", linkId, { status: "expired" }));
    await harness.t.run((ctx) => syncLegacyStatus(ctx, opportunityId));
    expect(await readDeal(harness, opportunityId)).toMatchObject({
      status: "follow_up_scheduled",
      updatedAt: 1_234,
    });
  });

  it("syncLegacyStatus writes nothing when the status already agrees", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");
    const before = await readDeal(harness, opportunityId);

    await harness.t.run((ctx) => syncLegacyStatus(ctx, opportunityId));

    expect(await readDeal(harness, opportunityId)).toEqual(before);
  });

  it("patchOpportunityLifecycle rewrites the status with a change to the loss", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "no_show");

    await harness.t.run((ctx) =>
      patchOpportunityLifecycle(ctx, opportunityId, { lostByUserId: harness.closerId }),
    );

    expect((await readDeal(harness, opportunityId)).status).toBe("lost");
    await harness.t.run((ctx) => expectStatusCopiesMatch(ctx, harness.tenantId));
  });

  it("patchOpportunityLifecycle refuses a stage, an outcome or a status", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await dealAt(harness, "scheduled");

    for (const patch of [{ stage: "closed" }, { outcome: "won" }, { status: "lost" }]) {
      await expect(
        harness.t.run(async (ctx) => {
          // @ts-expect-error not patchable fields
          await patchOpportunityLifecycle(ctx, opportunityId, patch);
        }),
      ).rejects.toThrow("Use transitionOpportunity");
    }
    expect(await readDeal(harness, opportunityId)).toMatchObject({ stage: "booked", outcome: "open" });
  });
});

describe("the inserts write the stage, the status, and the stage in opportunity.created", () => {
  async function createdEvent(harness: EnrollmentHarness, opportunityId: Id<"opportunities">) {
    const events = await harness.t.run((ctx) => dealEvents(ctx, harness.tenantId, opportunityId));
    return events.find((event) => event.eventType === "opportunity.created");
  }

  it("a cold Calendly booking starts Booked", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId } = await book(harness, "cold");

    expect(await readDeal(harness, opportunityId)).toMatchObject({
      status: "scheduled",
      stage: "booked",
      outcome: "open",
    });
    expect(await createdEvent(harness, opportunityId)).toMatchObject({
      toStatus: "booked",
      metadata: expect.objectContaining({ toOutcome: "open" }),
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
    expect(await createdEvent(harness, deals[0]._id)).toMatchObject({ toStatus: "qualified" });
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
    expect(await createdEvent(harness, opportunityId)).toMatchObject({ toStatus: "call_held" });
    expect(await harness.t.run((ctx) => countAtStage(ctx, harness.tenantId, "call_held", "open"))).toBe(1);
  });
});

describe("the public write paths", () => {
  it("a closer's no-show closes the deal with its code, and a reschedule link reopens it at Follow-up", async () => {
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
    expect(missed.lostAt).toBe(missed.noShowAt);
    expect(missed.lostByUserId).toBeUndefined();

    await harness.closer.mutation(api.closer.noShowActions.createNoShowRescheduleLink, {
      opportunityId,
      meetingId,
    });
    const reopened = await readDeal(harness, opportunityId);
    expect(reopened).toMatchObject({ status: "reschedule_link_sent", stage: "follow_up", outcome: "open" });
    expect([reopened.lostReason, reopened.lostAt]).toEqual([undefined, undefined]);

    const moves = (await harness.t.run((ctx) => dealEvents(ctx, harness.tenantId, opportunityId))).filter(
      (event) => event.eventType !== "opportunity.created",
    );
    expect(moves.map((event) => [event.eventType, event.fromStatus, event.toStatus, event.reason])).toEqual([
      // The closer's no-show reason is the event's.
      ["opportunity.marked_lost", "booked", "closed", "no_response"],
      ["opportunity.stage_changed", "closed", "follow_up", undefined],
    ]);
    await harness.t.run((ctx) => expectStatusCopiesMatch(ctx, harness.tenantId));
  });
});
