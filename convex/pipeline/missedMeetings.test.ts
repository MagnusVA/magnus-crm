/**
 * A missed meeting ends the deal (phase 5, D16), in today's statuses: a
 * no-show or a plain cancellation leaves the deal behind, and the person's
 * next booking is a new deal. The deal goes on only when Calendly moves the
 * booking (its cancel says `rescheduled`) or through a link the closer sent.
 */
import { afterEach, expect, it, vi } from "vitest";
import { inviteeUri, missedMeetingHarness } from "../../tests/missedMeetingFixtures";

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
        status: "scheduled",
        calendlyEventUri: "https://api.calendly.com/scheduled_events/original",
      });
      expect(deal?.canceledAt).toBeUndefined();
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
      status: "scheduled",
      calendlyEventUri: "https://api.calendly.com/scheduled_events/moved",
    });
    expect(deal?.canceledAt).toBeUndefined();
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

  expect(await h.meeting("original")).toMatchObject({ status: "canceled" });
  expect(await h.deal(opportunityId)).toMatchObject({
    status: "canceled",
    canceledAt: Date.parse("2026-10-04T09:00:00Z"),
    cancellationReason: "Schedule conflict",
  });
});
