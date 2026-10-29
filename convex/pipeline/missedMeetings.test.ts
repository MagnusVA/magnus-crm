/**
 * A missed meeting ends the deal (phase 5, D16), in today's statuses: a
 * no-show or a plain cancellation leaves the deal behind, and the person's
 * next booking is a new deal. The deal goes on only when Calendly moves the
 * booking (its cancel says `rescheduled`) or through a link the closer sent.
 */
import { afterEach, expect, it, vi } from "vitest";
import {
  crmLinkTracking,
  inviteeUri,
  minutesFromNow,
  missedMeetingHarness,
  type MissedMeetingHarness,
} from "../../tests/missedMeetingFixtures";
import { namedStatus } from "../../tests/stopStatusFixtures";

afterEach(() => vi.useRealTimers());

const ORIGINAL = { key: "original", start: "2026-10-06T15:00:00Z" };
const BOOKED_AT = "2026-10-02T10:00:00Z";
const RESCHEDULE_CANCEL = {
  ...ORIGINAL,
  canceled: { rescheduledTo: inviteeUri("moved") },
};
const MOVED = {
  key: "moved",
  start: "2026-10-07T15:00:00Z",
  oldInvitee: inviteeUri("original"),
};

/** Ends the original booking's deal the way a missed meeting does. */
async function missMeeting(h: MissedMeetingHarness, how: "no_show" | "canceled") {
  if (how === "no_show")
    await h.deliver("invitee_no_show.created", ORIGINAL, "2026-10-06T16:00:00Z");
  else
    await h.deliver("invitee.canceled", { ...ORIGINAL, canceled: {} }, "2026-10-04T09:00:00Z");
}

it.each(["cancel first", "new booking first"] as const)(
  "a Calendly reschedule keeps the deal scheduled and moves it to the new booking (%s)",
  async (order) => {
    const h = await missedMeetingHarness();
    const { opportunityId, meetingId } = await h.book(ORIGINAL, BOOKED_AT);

    if (order === "cancel first") {
      await h.deliver("invitee.canceled", RESCHEDULE_CANCEL, "2026-10-03T09:00:00Z");
      // The meeting is canceled, the deal isn't: its booking moved.
      expect(await h.meeting("original")).toMatchObject({
        status: "canceled",
        canceledAt: Date.parse("2026-10-03T09:00:00Z"),
      });
      const deal = await h.deal(opportunityId);
      expect(deal).toMatchObject({
        stage: "booked",
        calendlyEventUri: "https://api.calendly.com/scheduled_events/original",
      });
      await h.deliver("invitee.created", MOVED, "2026-10-03T09:00:03Z");
    } else {
      await h.deliver("invitee.created", MOVED, "2026-10-03T09:00:03Z");
      await h.deliver("invitee.canceled", RESCHEDULE_CANCEL, "2026-10-03T09:00:00Z");
    }

    expect(await h.receipt("invitee.canceled", "original")).toMatchObject({
      status: "applied",
      meetingId,
    });
    expect(await h.receipt("invitee.created", "moved")).toMatchObject({
      status: "applied",
      opportunityId,
    });
    expect(await h.meeting("original")).toMatchObject({ status: "canceled" });
    expect(await h.meeting("moved")).toMatchObject({
      status: "scheduled",
      opportunityId,
      rescheduledFromMeetingId: meetingId,
    });
    const deal = await h.deal(opportunityId);
    expect(deal).toMatchObject({
      stage: "booked",
      calendlyEventUri: "https://api.calendly.com/scheduled_events/moved",
    });
    expect(await h.dealCount()).toBe(1);
    expect(
      await h.t.run((ctx) => ctx.db.query("calendlyBookingFacts").take(5)),
    ).toMatchObject([{ inviteeUri: inviteeUri("original"), rescheduled: true }]);
  },
);

it("a cancel without the reschedule flag still cancels the deal", async () => {
  const h = await missedMeetingHarness();
  const { opportunityId } = await h.book(ORIGINAL, BOOKED_AT);

  await h.deliver("invitee.canceled", { ...ORIGINAL, canceled: {} }, "2026-10-04T09:00:00Z");

  expect(await h.meeting("original")).toMatchObject({
    status: "canceled",
    canceledAt: Date.parse("2026-10-04T09:00:00Z"),
  });
  expect(await h.deal(opportunityId)).toMatchObject({
    stage: "closed",
    outcome: "lost",
    lostReason: "canceled",
    cancellationReason: "Schedule conflict",
  });
});

it.each(["no_show", "canceled"] as const)(
  "a booking without a link days after a %s makes a new deal and leaves the old one alone",
  async (missed) => {
    const h = await missedMeetingHarness();
    const old = await h.book(ORIGINAL, BOOKED_AT);
    await missMeeting(h, missed);
    const before = { deal: await h.deal(old.opportunityId), meeting: await h.meeting("original") };
    expect(before.deal).toMatchObject({ stage: "closed", outcome: "lost", lostReason: missed });

    // Six days after booking, well inside the 14 days the old join used.
    const next = await h.book({ key: "rebook", start: "2026-10-12T15:00:00Z" }, "2026-10-08T10:00:00Z");

    expect(next.opportunityId).not.toBe(old.opportunityId);
    expect(await h.deal(next.opportunityId)).toMatchObject({
      stage: "booked",
      source: "calendly",
      leadId: before.deal?.leadId,
    });
    const meeting = await h.meeting("rebook");
    expect(meeting).toMatchObject({ opportunityId: next.opportunityId, callClassification: "new" });
    expect(meeting?.rescheduledFromMeetingId).toBeUndefined();
    expect(await h.creationSideEffects(next.opportunityId)).toEqual({
      created: true,
      closerCredit: 1,
      firstTouch: true,
      totalOpportunities: 2,
    });
    expect(await h.deal(old.opportunityId)).toEqual(before.deal);
    expect(await h.meeting("original")).toEqual(before.meeting);
  },
);

it.each(["no_show", "canceled"] as const)(
  "a Calendly reschedule of a booking whose deal ended as %s makes a new deal",
  async (missed) => {
    const h = await missedMeetingHarness();
    const old = await h.book(ORIGINAL, BOOKED_AT);
    await missMeeting(h, missed);
    const before = { deal: await h.deal(old.opportunityId), meeting: await h.meeting("original") };

    const next = await h.book(MOVED, "2026-10-08T10:00:00Z");

    expect(next.opportunityId).not.toBe(old.opportunityId);
    expect(await h.deal(next.opportunityId)).toMatchObject({
      stage: "booked",
      calendlyEventUri: "https://api.calendly.com/scheduled_events/moved",
    });
    // Rescheduled-from links meetings of one deal; this one starts its own.
    const meeting = await h.meeting("moved");
    expect(meeting).toMatchObject({ opportunityId: next.opportunityId, status: "scheduled" });
    expect(meeting?.rescheduledFromMeetingId).toBeUndefined();
    expect(await h.creationSideEffects(next.opportunityId)).toMatchObject({
      created: true,
      totalOpportunities: 2,
    });
    expect(await h.deal(old.opportunityId)).toEqual(before.deal);
    expect(await h.meeting("original")).toEqual(before.meeting);
  },
);

it("a booking through the closer's scheduling link moves the deal from Follow-up to Booked and marks the link booked", async () => {
  const h = await missedMeetingHarness();
  const { opportunityId, meetingId } = await h.book(ORIGINAL, BOOKED_AT);
  // After the call, the closer sends a scheduling link: the deal moves to
  // Follow-up at once and the call is held.
  h.clockAt("2026-10-06T15:40:00Z");
  const linkId = await h.closerActions.schedulingLink(opportunityId, meetingId);
  expect(await h.deal(opportunityId)).toMatchObject({ stage: "follow_up", outcome: "open" });
  expect(await h.meeting("original")).toMatchObject({ status: "held" });

  const next = await h.book(
    {
      key: "rebook",
      start: "2026-10-09T15:00:00Z",
      tracking: crmLinkTracking("follow_up", opportunityId, linkId),
    },
    minutesFromNow(60),
  );

  expect(next.opportunityId).toBe(opportunityId);
  expect(await h.deal(opportunityId)).toMatchObject({
    stage: "booked",
    outcome: "open",
    calendlyEventUri: "https://api.calendly.com/scheduled_events/rebook",
  });
  expect((await h.followUps(opportunityId)).find((f) => f._id === linkId)).toMatchObject({
    status: "booked",
    calendlyEventUri: "https://api.calendly.com/scheduled_events/rebook",
  });
  expect(await h.meeting("rebook")).toMatchObject({ status: "scheduled", opportunityId });
  expect(await h.dealCount()).toBe(1);
});

it("a booking through a CRM link on a deal waiting on a reschedule link expires that reschedule link", async () => {
  const h = await missedMeetingHarness();
  const { opportunityId, meetingId } = await h.book(ORIGINAL, BOOKED_AT);
  // Before the call, a scheduling link was left pending on the Booked deal (as
  // the old dialog could, before links moved the deal at once).
  h.clockAt("2026-10-03T10:00:00Z");
  const schedulingLinkId = await h.closerActions.legacyUnconfirmedSchedulingLink(opportunityId);
  await missMeeting(h, "no_show");
  h.clockAt("2026-10-06T17:00:00Z");
  const rescheduleLinkId = await h.closerActions.rescheduleLink(opportunityId, meetingId);
  expect(await h.t.run((ctx) => namedStatus(ctx, opportunityId))).toBe("reschedule_link_sent");

  // The person books through the older scheduling link.
  await h.book(
    {
      key: "rebook",
      start: "2026-10-09T15:00:00Z",
      tracking: crmLinkTracking("follow_up", opportunityId, schedulingLinkId),
    },
    minutesFromNow(60),
  );

  expect(await h.t.run((ctx) => namedStatus(ctx, opportunityId))).toBe("scheduled");
  const links = await h.followUps(opportunityId);
  expect(links.find((f) => f._id === schedulingLinkId)).toMatchObject({ status: "booked" });
  expect(links.find((f) => f._id === rescheduleLinkId)).toMatchObject({ status: "expired" });
  const events = await h.t.run((ctx) =>
    ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", h.tenantId).eq("entityType", "followUp").eq("entityId", rescheduleLinkId),
      )
      .take(10),
  );
  expect(events.map((e) => [e.eventType, e.fromStatus, e.toStatus])).toContainEqual([
    "followUp.expired",
    "pending",
    "expired",
  ]);
});

it("the closer's reschedule link still joins the no-show deal", async () => {
  const h = await missedMeetingHarness();
  const { opportunityId, meetingId } = await h.book(ORIGINAL, BOOKED_AT);
  await missMeeting(h, "no_show");
  h.clockAt("2026-10-06T17:00:00Z");
  const rescheduleLinkId = await h.closerActions.rescheduleLink(opportunityId, meetingId);

  const next = await h.book(
    {
      key: "rebook",
      start: "2026-10-09T15:00:00Z",
      tracking: crmLinkTracking("noshow_resched", opportunityId, meetingId),
    },
    minutesFromNow(60),
  );

  expect(next.opportunityId).toBe(opportunityId);
  expect(await h.t.run((ctx) => namedStatus(ctx, opportunityId))).toBe("scheduled");
  expect(await h.meeting("rebook")).toMatchObject({ rescheduledFromMeetingId: meetingId });
  expect((await h.followUps(opportunityId)).find((f) => f._id === rescheduleLinkId)).toMatchObject({
    status: "booked",
  });
  expect(await h.dealCount()).toBe(1);
});
