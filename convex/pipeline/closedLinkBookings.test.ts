/**
 * A link the CRM sent keeps working in Calendly after its task closed
 * (canceled from the task page, or closed with the deal marked lost). The
 * person's booking through it is real: it goes the ordinary way, joining an
 * eligible Follow-up deal or starting a new one, and never reopens a lost
 * deal (pipeline/bookingTargets.ts `closedBookingLink`).
 */
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import {
  crmLinkTracking,
  minutesFromNow,
  missedMeetingHarness,
  type MissedMeetingHarness,
} from "../../tests/missedMeetingFixtures";

afterEach(() => vi.useRealTimers());

const ORIGINAL = { key: "original", start: "2026-10-06T15:00:00Z" };
const BOOKED_AT = "2026-10-02T10:00:00Z";

/** A booked call, held, and a scheduling link from its outcome: the deal is at Follow-up. */
async function linkAfterHeldCall(h: MissedMeetingHarness) {
  const { opportunityId, meetingId } = await h.book(ORIGINAL, BOOKED_AT);
  h.clockAt("2026-10-06T15:40:00Z");
  const linkId = await h.closerActions.schedulingLink(opportunityId, meetingId);
  return { opportunityId, linkId };
}

it("a booking through a canceled scheduling link joins the deal still at Follow-up", async () => {
  const h = await missedMeetingHarness();
  const { opportunityId, linkId } = await linkAfterHeldCall(h);
  h.clockAt("2026-10-07T09:00:00Z");
  await h.closer.mutation(api.closer.linkTaskOutcomes.cancelLinkTask, { followUpId: linkId });

  const next = await h.book(
    { key: "rebook", start: "2026-10-12T15:00:00Z", tracking: crmLinkTracking("follow_up", opportunityId, linkId) },
    minutesFromNow(60),
  );

  expect(next.opportunityId).toBe(opportunityId);
  expect(await h.deal(opportunityId)).toMatchObject({ stage: "booked", outcome: "open" });
  const closerId = (await h.deal(opportunityId))!.assignedCloserId;
  expect(await h.meeting("rebook")).toMatchObject({ status: "scheduled", assignedCloserId: closerId });
  // The canceled link stays canceled; it never comes back as a task.
  expect((await h.followUps(opportunityId)).find((f) => f._id === linkId)?.status).toBe("expired");
  expect(await h.dealCount()).toBe(1);
});

it("a booking through a reschedule link after the deal was marked lost starts a new deal for the closer", async () => {
  const h = await missedMeetingHarness();
  const { opportunityId, meetingId } = await h.book(ORIGINAL, BOOKED_AT);
  await h.deliver("invitee_no_show.created", ORIGINAL, "2026-10-06T16:00:00Z");
  h.clockAt("2026-10-06T17:00:00Z");
  const rescheduleLinkId = await h.closerActions.rescheduleLink(opportunityId, meetingId);
  h.clockAt("2026-10-08T09:00:00Z");
  await h.closer.mutation(api.closer.linkTaskOutcomes.markLinkTaskLost, {
    followUpId: rescheduleLinkId,
    reason: "Stopped replying",
  });
  const lostDeal = await h.deal(opportunityId);

  const next = await h.book(
    {
      key: "rebook",
      start: "2026-10-12T15:00:00Z",
      tracking: crmLinkTracking("noshow_resched", opportunityId, meetingId),
    },
    minutesFromNow(60),
  );

  expect(next.opportunityId).not.toBe(opportunityId);
  expect(await h.deal(next.opportunityId)).toMatchObject({
    stage: "booked",
    outcome: "open",
    assignedCloserId: lostDeal!.assignedCloserId,
  });
  expect(await h.creationSideEffects(next.opportunityId)).toMatchObject({
    created: true,
    closerCredit: 1,
    totalOpportunities: 2,
  });
  // The lost deal stays lost.
  expect(await h.deal(opportunityId)).toEqual(lostDeal);
});

it("a late delivery of a booking made before the link was canceled still lands on the deal", async () => {
  const h = await missedMeetingHarness();
  const { opportunityId, linkId } = await linkAfterHeldCall(h);
  // The person books at 10:00; the webhook is processed after the closer
  // canceled the link at 11:00.
  const bookedAt = "2026-10-07T10:00:00Z";
  h.clockAt("2026-10-07T11:00:00Z");
  await h.closer.mutation(api.closer.linkTaskOutcomes.cancelLinkTask, { followUpId: linkId });

  const next = await h.book(
    { key: "rebook", start: "2026-10-12T15:00:00Z", tracking: crmLinkTracking("follow_up", opportunityId, linkId) },
    bookedAt,
  );

  expect(next.opportunityId).toBe(opportunityId);
  expect(await h.deal(opportunityId)).toMatchObject({ stage: "booked", outcome: "open" });
  expect(await h.dealCount()).toBe(1);
});

it("a link that names another tenant's or no real follow-up still blocks", async () => {
  const h = await missedMeetingHarness();
  const { opportunityId } = await linkAfterHeldCall(h);

  await h.deliver(
    "invitee.created",
    {
      key: "forged",
      start: "2026-10-12T15:00:00Z",
      tracking: crmLinkTracking("follow_up", opportunityId, "not-a-follow-up-id"),
    },
    minutesFromNow(60),
  );

  expect(await h.receipt("invitee.created", "forged")).toMatchObject({
    status: "blocked",
    reason: "invalid_booking_link",
  });
  expect(await h.deal(opportunityId)).toMatchObject({ stage: "follow_up" });
});
