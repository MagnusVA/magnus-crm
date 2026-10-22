/**
 * `backfillCancelRescheduledFlags` and its assert (docs/plans/phase-5-deal-status.md
 * §10.5): a cancel fact recorded before `calendlyBookingFacts.rescheduled`
 * existed gets Calendly's flag from the stored cancel, so a booking whose
 * meeting appears later reads a reschedule's cancel as one.
 */
import { afterEach, expect, it, vi } from "vitest";
import { inviteeUri, missedMeetingHarness } from "../../tests/missedMeetingFixtures";

afterEach(() => vi.useRealTimers());

const START = "2026-10-06T15:00:00Z";
/** Calendly's cancel of `key` when it moved the booking to a new invitee. */
const rescheduleCancel = (key: string) => ({
  key,
  start: START,
  canceled: { rescheduledTo: inviteeUri(`${key}-new`) },
});

it("flags each stored reschedule's cancel fact that lacks the flag, and writes nothing else", async () => {
  const h = await missedMeetingHarness();
  // Stored deliveries for bookings the CRM hasn't applied yet, so only their
  // facts hold them. The facts were recorded before the field existed.
  await h.deliver("invitee.canceled", rescheduleCancel("moved"), "2026-10-03T09:00:00Z");
  await h.deliver("invitee.canceled", { key: "plain", start: START, canceled: {} }, "2026-10-03T09:01:00Z");
  // A no-show whose invitee object says rescheduled: only a cancel's flag counts.
  await h.deliver("invitee_no_show.created", rescheduleCancel("absent"), "2026-10-03T09:02:00Z");
  // A stored reschedule cancel with no fact: the fact is written when it's processed.
  await h.deliver("invitee.canceled", rescheduleCancel("unrecorded"), "2026-10-03T09:03:00Z");
  await h.factWithoutRescheduledFlag("moved");
  await h.factWithoutRescheduledFlag("plain");
  await h.t.run(async (ctx) => {
    const unrecorded = (await ctx.db.query("calendlyBookingFacts").take(10)).find(
      (fact) => fact.inviteeUri === inviteeUri("unrecorded"),
    );
    await ctx.db.delete("calendlyBookingFacts", unrecorded!._id);
    // A stored payload that doesn't parse.
    await ctx.db.insert("rawWebhookEvents", {
      tenantId: h.tenantId,
      calendlyEventUri: inviteeUri("garbled"),
      eventType: "invitee.canceled",
      payload: "{not json",
      processed: false,
      receivedAt: Date.now(),
    });
  });
  const rawEvents = () => h.t.run((ctx) => ctx.db.query("rawWebhookEvents").take(20));
  const before = { facts: await h.facts(), raw: await rawEvents() };
  expect(Object.keys(before.facts).sort()).toEqual(["absent", "moved", "plain"]);
  expect(before.facts.absent.rescheduled).toBeUndefined();

  const failed = await h.runMigration("assertCancelRescheduledFlags");
  expect(failed?.error).toContain(before.facts.moved._id);

  expect(await h.runMigration("backfillCancelRescheduledFlags")).toMatchObject({ isDone: true, state: "success" });
  const after = await h.facts();
  expect(after).toEqual({ ...before.facts, moved: { ...before.facts.moved, rescheduled: true } });
  expect(await rawEvents()).toEqual(before.raw);

  const passed = await h.runMigration("assertCancelRescheduledFlags", { reset: true });
  expect(passed).toMatchObject({ isDone: true, state: "success" });
  expect(passed?.error).toBeUndefined();

  // A rerun changes nothing.
  expect(await h.runMigration("backfillCancelRescheduledFlags", { reset: true })).toMatchObject({ isDone: true });
  expect(await h.facts()).toEqual(after);
});

it.each([
  ["after the backfill", "scheduled"],
  ["without the backfill", "canceled"],
] as const)(
  "the late booking of a reschedule's cancel stored before the flag existed: %s its deal is %s",
  async (when, status) => {
    const h = await missedMeetingHarness();
    // The cancel arrived first and waits on its booking (booking_not_tracked).
    await h.deliver("invitee.canceled", rescheduleCancel("original"), "2026-10-03T09:00:00Z");
    await h.factWithoutRescheduledFlag("original");
    if (when === "after the backfill") await h.runMigration("backfillCancelRescheduledFlags");

    const { opportunityId } = await h.book({ key: "original", start: START }, "2026-10-02T10:00:00Z");

    expect(await h.meeting("original")).toMatchObject({ status: "canceled" });
    expect(await h.deal(opportunityId)).toMatchObject({ status });
  },
);
