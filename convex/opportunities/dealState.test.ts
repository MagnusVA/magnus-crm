import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { OPPORTUNITY_STATUSES, type OpportunityStatus } from "./stages";
import {
  isMissedMeetingLoss,
  legacyStatus,
  loadDealState,
  loadPendingRescheduleLink,
} from "./dealState";
import type { DealSource } from "./stages";
import { bookingHarness } from "../../tests/bookingHarness";
import { harnessCloserId } from "../../tests/dealStageFixtures";
import {
  dealAt,
  insertDealTask,
  insertWrittenDeal,
} from "../../tests/dealStateFixtures";

// Today's status rebuilt from the deal's stage, outcome, loss and tasks
// (docs/plans/phase-5-deal-status.md §4.3, §4.6).

afterEach(() => vi.useRealTimers());

const SOURCES: (DealSource | undefined)[] = ["calendly", "slack_qualified", "side_deal", undefined];

const linkFor = (status: OpportunityStatus) => ({
  hasPendingRescheduleLink: status === "reschedule_link_sent",
});

describe("isMissedMeetingLoss", () => {
  it.each(["no_show", "canceled"] as const)("names a deal the system closed for a %s", (reason) => {
    expect(isMissedMeetingLoss(dealAt(reason, "calendly"))).toBe(reason);
  });

  it("is null for a loss a person recorded, even with the system's code", () => {
    const userId = "user" as Id<"users">;
    expect(
      isMissedMeetingLoss(dealAt("lost", "calendly", { fields: { lostReason: "no_show", lostByUserId: userId } })),
    ).toBeNull();
    expect(
      isMissedMeetingLoss(dealAt("no_show", "calendly", { fields: { lostByUserId: userId } })),
    ).toBeNull();
  });

  it.each([
    ["the Slack expiry", { lostReason: "stale" }],
    ["a free-text reason", { lostReason: "budget" }],
    ["no reason", {}],
  ])("is null for a loss with %s", (_label, fields) => {
    expect(isMissedMeetingLoss(dealAt("lost", "slack_qualified", { fields }))).toBeNull();
  });

  it.each(["qualified_pending", "scheduled", "follow_up_scheduled", "reschedule_link_sent", "payment_received"] as const)(
    "is null for an open or won deal (%s), whatever its reason",
    (status) => {
      expect(isMissedMeetingLoss(dealAt(status, "calendly", { fields: { lostReason: "no_show" } }))).toBeNull();
    },
  );
});

describe("legacyStatus", () => {
  const matrix = OPPORTUNITY_STATUSES.flatMap((status) =>
    SOURCES.map((source) => [status, source ?? "no source"] as const),
  );

  it.each(matrix)("rebuilds %s on a deal from %s", (status, sourceLabel) => {
    const source = sourceLabel === "no source" ? undefined : sourceLabel;
    expect(legacyStatus(dealAt(status, source), linkFor(status))).toBe(status);
  });

  it.each(matrix)("rebuilds %s from the status on a %s deal with no stored stage", (status, sourceLabel) => {
    const source = sourceLabel === "no source" ? undefined : sourceLabel;
    expect(legacyStatus(dealAt(status, source, { written: false }), linkFor(status))).toBe(status);
  });

  it("reads the stored stage and outcome over the status", () => {
    const deal = dealAt("scheduled", "calendly", { fields: { stage: "closed", outcome: "won" } });
    expect(legacyStatus(deal, { hasPendingRescheduleLink: false })).toBe("payment_received");
  });

  it("reads a reschedule link only on a Follow-up deal", () => {
    for (const status of ["scheduled", "qualified_pending", "payment_received", "lost", "no_show"] as const) {
      expect(legacyStatus(dealAt(status, "calendly"), { hasPendingRescheduleLink: true })).toBe(status);
    }
    expect(legacyStatus(dealAt("follow_up_scheduled", "calendly"), { hasPendingRescheduleLink: true })).toBe(
      "reschedule_link_sent",
    );
    expect(legacyStatus(dealAt("reschedule_link_sent", "calendly"), { hasPendingRescheduleLink: false })).toBe(
      "follow_up_scheduled",
    );
  });

  it("rebuilds a loss a person recorded with the system's code as lost", () => {
    const deal = dealAt("lost", "calendly", {
      fields: { lostReason: "canceled", lostByUserId: "user" as Id<"users"> },
    });
    expect(legacyStatus(deal, { hasPendingRescheduleLink: false })).toBe("lost");
  });

  it("rebuilds a canceled or no-show deal without its loss as lost", () => {
    for (const status of ["canceled", "no_show"] as const) {
      const deal = dealAt(status, "calendly", { fields: { lostReason: undefined } });
      expect(legacyStatus(deal, { hasPendingRescheduleLink: false })).toBe("lost");
    }
  });

  it("throws on a stage and outcome pair the stage doesn't allow", () => {
    const deal = dealAt("payment_received", "calendly", { fields: { outcome: "open" } });
    expect(() => legacyStatus(deal, { hasPendingRescheduleLink: false })).toThrow(
      'Deal stage "closed" doesn\'t allow outcome "open"',
    );
  });
});

describe("loadPendingRescheduleLink and loadDealState", () => {
  async function harnessWithDeal(status: OpportunityStatus, source: DealSource = "calendly") {
    const harness = await bookingHarness();
    const opportunityId = await harness.t.run((ctx) =>
      insertWrittenDeal(ctx, { tenantId: harness.tenantId, status, source }),
    );
    return { harness, opportunityId };
  }

  async function stateOf(harness: Awaited<ReturnType<typeof bookingHarness>>, opportunityId: Id<"opportunities">) {
    return await harness.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", opportunityId))!;
      return {
        link: await loadPendingRescheduleLink(ctx, opportunityId),
        state: await loadDealState(ctx, deal),
      };
    });
  }

  it("finds the pending reschedule link of a deal a reschedule link reopened", async () => {
    const { harness, opportunityId } = await harnessWithDeal("reschedule_link_sent");
    const linkId = await harness.t.run((ctx) => insertDealTask(ctx, opportunityId));

    const { link, state } = await stateOf(harness, opportunityId);
    expect(link).toEqual({ link: expect.objectContaining({ _id: linkId }), count: 1 });
    expect(state).toEqual({
      position: "follow_up",
      missedMeeting: null,
      rescheduleLinkPending: true,
      legacyStatus: "reschedule_link_sent",
    });
  });

  it("names the newest of several pending reschedule links, and counts them", async () => {
    const { harness, opportunityId } = await harnessWithDeal("reschedule_link_sent");
    await harness.t.run((ctx) => insertDealTask(ctx, opportunityId, { createdAt: 1 }));
    const newest = await harness.t.run((ctx) => insertDealTask(ctx, opportunityId, { createdAt: 2 }));

    const { link } = await stateOf(harness, opportunityId);
    expect(link.count).toBe(2);
    expect(link.link?._id).toBe(newest);
  });

  it("doesn't count an ordinary scheduling link: that Follow-up deal is follow_up_scheduled", async () => {
    const { harness, opportunityId } = await harnessWithDeal("follow_up_scheduled");
    await harness.t.run((ctx) => insertDealTask(ctx, opportunityId, { reason: "closer_initiated" }));

    const { link, state } = await stateOf(harness, opportunityId);
    expect(link).toEqual({ link: null, count: 0 });
    expect(state).toEqual({
      position: "follow_up",
      missedMeeting: null,
      rescheduleLinkPending: false,
      legacyStatus: "follow_up_scheduled",
    });
  });

  it("doesn't count a reminder, or a reschedule link no longer pending", async () => {
    const { harness, opportunityId } = await harnessWithDeal("follow_up_scheduled");
    await harness.t.run(async (ctx) => {
      await insertDealTask(ctx, opportunityId, { type: "manual_reminder" });
      for (const status of ["booked", "completed", "expired"] as const) {
        await insertDealTask(ctx, opportunityId, { status });
      }
    });

    const { link, state } = await stateOf(harness, opportunityId);
    expect(link).toEqual({ link: null, count: 0 });
    expect(state.legacyStatus).toBe("follow_up_scheduled");
  });

  it("reads another deal's reschedule link as none of this deal's", async () => {
    const { harness, opportunityId } = await harnessWithDeal("follow_up_scheduled");
    await harness.t.run(async (ctx) => {
      const other = await insertWrittenDeal(ctx, { tenantId: harness.tenantId, status: "reschedule_link_sent" });
      await insertDealTask(ctx, other);
    });

    expect((await stateOf(harness, opportunityId)).state.rescheduleLinkPending).toBe(false);
  });

  it.each([
    ["no_show", "no_show"],
    ["canceled", "canceled"],
  ] as const)("names the missed meeting of a deal a %s closed", async (status, missed) => {
    const { harness, opportunityId } = await harnessWithDeal(status);

    expect((await stateOf(harness, opportunityId)).state).toEqual({
      position: "lost",
      missedMeeting: missed,
      rescheduleLinkPending: false,
      legacyStatus: status,
    });
  });

  it.each([
    ["qualified_pending", "slack_qualified", "qualified"],
    ["scheduled", "calendly", "booked"],
    ["scheduled", "side_deal", "call_held"],
    ["payment_received", "calendly", "won"],
    ["lost", "calendly", "lost"],
  ] as const)("gives a %s %s deal the position %s", async (status, source, position) => {
    const { harness, opportunityId } = await harnessWithDeal(status, source);
    if (status === "lost") {
      await harness.t.run(async (ctx) => {
        const { forceOpportunityState } = await import("../../tests/opportunityFixtures");
        await forceOpportunityState(ctx, opportunityId, {
          lostReason: "budget",
          lostByUserId: await harnessCloserId(ctx),
        });
      });
    }

    expect((await stateOf(harness, opportunityId)).state).toEqual({
      position,
      missedMeeting: null,
      rescheduleLinkPending: false,
      legacyStatus: status,
    });
  });
});
