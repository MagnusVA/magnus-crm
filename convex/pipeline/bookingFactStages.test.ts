/**
 * Calendly's facts move the deal through the stage machine from PR 8
 * (docs/plans/phase-5-deal-status.md §4.3, §4.4, §4.7): a no-show or a
 * cancellation closes it lost by the system, a withdrawn no-show reopens it
 * at Booked, and a flip between the two changes the reason in place with a
 * deal event, so the booking history still reads where the deal is. The
 * deal stores no status (PR 9); its stage, loss and tasks name the one PR 7
 * would have written.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  missedMeetingHarness,
  type MissedMeetingHarness,
} from "../../tests/missedMeetingFixtures";
import { legacyStatus, loadPendingRescheduleLink } from "../opportunities/dealState";
import type { OpportunityStatus } from "../opportunities/stages";
import { dealEvents } from "../../tests/stageMachineFixtures";

afterEach(() => vi.useRealTimers());

const ORIGINAL = { key: "original", start: "2026-10-06T15:00:00Z" };
const BOOKED_AT = "2026-10-02T10:00:00Z";
const NO_SHOW_AT = "2026-10-06T16:00:00Z";
const CANCELED_AT = "2026-10-06T17:00:00Z";

/** The deal stores no status, and its stage, loss and tasks name PR 7's `status`. */
async function expectPr7Status(
  h: MissedMeetingHarness,
  opportunityId: Id<"opportunities">,
  status: OpportunityStatus,
) {
  const { deal, links } = await h.t.run(async (ctx) => ({
    deal: (await ctx.db.get("opportunities", opportunityId))!,
    links: (await loadPendingRescheduleLink(ctx, opportunityId)).count,
  }));
  expect(deal.status).toBeUndefined();
  expect(legacyStatus(deal, { hasPendingRescheduleLink: links > 0 })).toBe(status);
}

async function moves(h: MissedMeetingHarness, opportunityId: Id<"opportunities">) {
  const events = await h.t.run((ctx) => dealEvents(ctx, h.tenantId, opportunityId));
  return events.filter((event) => event.eventType !== "opportunity.created");
}

describe("a Calendly fact on the deal's current booking", () => {
  it("closes a Booked deal lost by the system on a no-show", async () => {
    const h = await missedMeetingHarness();
    const { opportunityId } = await h.book(ORIGINAL, BOOKED_AT);

    await h.deliver("invitee_no_show.created", ORIGINAL, NO_SHOW_AT);

    const deal = await h.deal(opportunityId);
    expect(deal).toMatchObject({
      stage: "closed",
      outcome: "lost",
      lostReason: "no_show",
      lostAt: Date.parse(NO_SHOW_AT),
      noShowAt: Date.parse(NO_SHOW_AT),
    });
    expect(deal?.lostByUserId).toBeUndefined();
    expect(await moves(h, opportunityId)).toEqual([
      {
        eventType: "opportunity.marked_lost",
        fromStatus: "booked",
        toStatus: "closed",
        reason: "no_show",
        metadata: { fromOutcome: "open", toOutcome: "lost" },
      },
    ]);
    await expectPr7Status(h, opportunityId, "no_show");
  });

  it("closes a Booked deal lost by the system on a cancellation", async () => {
    const h = await missedMeetingHarness();
    const { opportunityId } = await h.book(ORIGINAL, BOOKED_AT);

    await h.deliver("invitee.canceled", { ...ORIGINAL, canceled: {} }, "2026-10-04T09:00:00Z");

    expect(await h.deal(opportunityId)).toMatchObject({
      stage: "closed",
      outcome: "lost",
      lostReason: "canceled",
      lostAt: Date.parse("2026-10-04T09:00:00Z"),
      canceledAt: Date.parse("2026-10-04T09:00:00Z"),
      cancellationReason: "Schedule conflict",
    });
    expect((await moves(h, opportunityId)).map((event) => [event.eventType, event.reason])).toEqual([
      ["opportunity.marked_lost", "canceled"],
    ]);
    await expectPr7Status(h, opportunityId, "canceled");
  });

  it("reopens the deal at Booked when Calendly withdraws the no-show", async () => {
    const h = await missedMeetingHarness();
    const { opportunityId } = await h.book(ORIGINAL, BOOKED_AT);
    await h.deliver("invitee_no_show.created", ORIGINAL, NO_SHOW_AT);

    await h.deliver("invitee_no_show.deleted", ORIGINAL, "2026-10-06T16:30:00Z");

    const deal = await h.deal(opportunityId);
    expect(deal).toMatchObject({ stage: "booked", outcome: "open" });
    expect([deal?.lostReason, deal?.lostAt, deal?.noShowAt]).toEqual([undefined, undefined, undefined]);
    expect((await moves(h, opportunityId)).at(-1)).toEqual({
      eventType: "opportunity.stage_changed",
      fromStatus: "closed",
      toStatus: "booked",
      reason: undefined,
      metadata: { fromOutcome: "lost", toOutcome: "open" },
    });
    await expectPr7Status(h, opportunityId, "scheduled");
  });

  it("changes the reason in place when a cancellation follows the no-show, with a closed -> closed event", async () => {
    const h = await missedMeetingHarness();
    const { opportunityId } = await h.book(ORIGINAL, BOOKED_AT);
    await h.deliver("invitee_no_show.created", ORIGINAL, NO_SHOW_AT);

    await h.deliver("invitee.canceled", { ...ORIGINAL, canceled: {} }, CANCELED_AT);

    const deal = await h.deal(opportunityId);
    expect(deal).toMatchObject({
      stage: "closed",
      outcome: "lost",
      lostReason: "canceled",
      lostAt: Date.parse(CANCELED_AT),
      canceledAt: Date.parse(CANCELED_AT),
      cancellationReason: "Schedule conflict",
    });
    // As PR 7 wrote them: the no-show time goes, and updatedAt moves.
    expect(deal?.noShowAt).toBeUndefined();
    expect(deal?.updatedAt).toBeGreaterThanOrEqual(Date.parse(CANCELED_AT));
    expect((await moves(h, opportunityId)).at(-1)).toEqual({
      eventType: "opportunity.stage_changed",
      fromStatus: "closed",
      toStatus: "closed",
      reason: "canceled",
      metadata: { fromOutcome: "lost", toOutcome: "lost" },
    });
    await expectPr7Status(h, opportunityId, "canceled");
  });
});

describe("a late booking after Calendly's flip", () => {
  const LATE = { key: "late", start: "2026-10-09T15:00:00Z" };
  // Calendly created the booking before the no-show; it is processed after the flip.
  const LATE_BOOKED_AT = "2026-10-05T10:00:00Z";

  /** The deal's history as PR 7 left it: the no-show recorded as an old status event. */
  async function noShowBeforePr8(h: MissedMeetingHarness) {
    const { opportunityId } = await h.book(ORIGINAL, BOOKED_AT);
    await h.deliver("invitee_no_show.created", ORIGINAL, NO_SHOW_AT);
    await h.t.run(async (ctx) => {
      const events = await ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
          q.eq("tenantId", h.tenantId).eq("entityType", "opportunity").eq("entityId", opportunityId),
        )
        .take(10);
      const loss = events.find((event) => event.eventType === "opportunity.marked_lost")!;
      await ctx.db.patch("domainEvents", loss._id, {
        eventType: "opportunity.status_changed",
        fromStatus: "scheduled",
        toStatus: "no_show",
        reason: undefined,
        metadata: undefined,
      });
    });
    await h.deliver("invitee.canceled", { ...ORIGINAL, canceled: {} }, CANCELED_AT);
    return opportunityId;
  }

  it("isn't held: the flip's deal event carries the history to where the deal is", async () => {
    const h = await missedMeetingHarness();
    const opportunityId = await noShowBeforePr8(h);

    await h.deliver("invitee.created", LATE, LATE_BOOKED_AT);

    const receipt = await h.receipt("invitee.created", "late");
    expect(receipt).toMatchObject({ status: "applied" });
    // The deal was Booked when the late booking happened, out of its reach.
    expect(receipt.opportunityId).not.toBe(opportunityId);
  });

  it("would be held without that event, as the history then ends at the no-show", async () => {
    const h = await missedMeetingHarness();
    const opportunityId = await noShowBeforePr8(h);
    await h.t.run(async (ctx) => {
      const events = await ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
          q.eq("tenantId", h.tenantId).eq("entityType", "opportunity").eq("entityId", opportunityId),
        )
        .take(10);
      const flip = events.find(
        (event) => event.fromStatus === "closed" && event.toStatus === "closed",
      )!;
      await ctx.db.delete("domainEvents", flip._id);
    });

    await h.deliver("invitee.created", LATE, LATE_BOOKED_AT);

    expect(await h.receipt("invitee.created", "late")).toMatchObject({
      status: "blocked",
      reason: "historical_booking_requires_review",
    });
  });
});
