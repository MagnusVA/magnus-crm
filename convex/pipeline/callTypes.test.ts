/**
 * Call types and moved slots on real bookings (docs/reviews/reports-decisions.html,
 * D5 and D9): a call is a first call until one is held on its deal, a slot a
 * reschedule gave up projects as moved, and a booking that replaces another
 * never counts as a new DM booking.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { meetingsByStatus } from "../reporting/aggregates";
import { requestMeetingDeleteProjections } from "../operations/meetingStats";
import {
  crmLinkTracking,
  inviteeUri,
  minutesFromNow,
  missedMeetingHarness,
  type Booking,
  type MissedMeetingHarness,
} from "../../tests/missedMeetingFixtures";

afterEach(() => vi.useRealTimers());

const BOOKED_AT = "2026-10-02T10:00:00Z";
const ORIGINAL: Booking = { key: "original", start: "2026-10-06T15:00:00Z" };
/** Calendly's reschedule of `from` to `key` at `start`: the cancel, then the new invitee. */
async function reschedule(h: MissedMeetingHarness, from: Booking, to: Booking, at: string) {
  await h.deliver("invitee.canceled", { ...from, canceled: { rescheduledTo: inviteeUri(to.key) } }, at);
  return await h.book({ ...to, oldInvitee: inviteeUri(from.key) }, at);
}

async function projectedStatus(h: MissedMeetingHarness, meetingId: Id<"meetings">) {
  const projection = await h.t.run((ctx) =>
    ctx.db
      .query("meetingProjections")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
      .unique(),
  );
  return projection?.contribution?.meetingStatus;
}

/** The closer records the call held and sends a follow-up link; returns the link's booking tracking. */
async function holdAndSendLink(h: MissedMeetingHarness, opportunityId: Id<"opportunities">, meetingId: Id<"meetings">, at: string) {
  h.clockAt(at);
  const followUpId = await h.closerActions.schedulingLink(opportunityId, meetingId);
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  return crmLinkTracking("follow_up", opportunityId, followUpId);
}

describe("the call type a booking writes", () => {
  it("files the first booking as a first call", async () => {
    const h = await missedMeetingHarness();
    await h.book(ORIGINAL, BOOKED_AT);
    expect(await h.meeting("original")).toMatchObject({ callClassification: "new" });
  });

  it("files a Calendly reschedule of a first call as a first call", async () => {
    const h = await missedMeetingHarness();
    const { meetingId } = await h.book(ORIGINAL, BOOKED_AT);
    await reschedule(h, ORIGINAL, { key: "moved", start: "2026-10-07T15:00:00Z" }, "2026-10-03T09:00:00Z");

    expect(await h.meeting("moved")).toMatchObject({
      callClassification: "new",
      rescheduledFromMeetingId: meetingId,
    });
  });

  it("files a rebook through the no-show link as a first call", async () => {
    const h = await missedMeetingHarness();
    const { opportunityId, meetingId } = await h.book(ORIGINAL, BOOKED_AT);
    await h.deliver("invitee_no_show.created", ORIGINAL, "2026-10-06T16:00:00Z");
    h.clockAt("2026-10-06T17:00:00Z");
    await h.closerActions.rescheduleLink(opportunityId, meetingId);
    await h.book(
      { key: "rebook", start: "2026-10-09T15:00:00Z", tracking: crmLinkTracking("noshow_resched", opportunityId, meetingId) },
      minutesFromNow(60),
    );

    expect(await h.meeting("rebook")).toMatchObject({
      opportunityId,
      callClassification: "new",
      rescheduledFromMeetingId: meetingId,
    });
  });

  it("files a booking after a held call, and its reschedule, as follow-ups", async () => {
    const h = await missedMeetingHarness();
    const { opportunityId, meetingId } = await h.book(ORIGINAL, BOOKED_AT);
    const tracking = await holdAndSendLink(h, opportunityId, meetingId, "2026-10-06T16:00:00Z");
    expect(await h.meeting("original")).toMatchObject({ status: "held", callClassification: "new" });

    const second: Booking = { key: "second", start: "2026-10-09T15:00:00Z", tracking };
    await h.book(second, minutesFromNow(10));
    expect(await h.meeting("second")).toMatchObject({ opportunityId, callClassification: "follow_up" });

    await reschedule(h, second, { key: "second-moved", start: "2026-10-10T15:00:00Z", tracking }, minutesFromNow(60));
    expect(await h.meeting("second-moved")).toMatchObject({ opportunityId, callClassification: "follow_up" });
  });
});

describe("moved slots in the Operations projection", () => {
  it("moves a rescheduled slot from canceled to moved, and back when its successor is deleted", async () => {
    const h = await missedMeetingHarness();
    const { meetingId } = await h.book(ORIGINAL, BOOKED_AT);
    // Until the new booking arrives, the slot is only canceled.
    await h.deliver("invitee.canceled", { ...ORIGINAL, canceled: { rescheduledTo: inviteeUri("moved") } }, "2026-10-03T09:00:00Z");
    expect(await projectedStatus(h, meetingId)).toBe("canceled");

    const moved = await h.book(
      { key: "moved", start: "2026-10-07T15:00:00Z", oldInvitee: inviteeUri("original") },
      "2026-10-03T09:00:03Z",
    );
    expect(await projectedStatus(h, meetingId)).toBe("moved");
    expect(await projectedStatus(h, moved.meetingId)).toBe("scheduled");

    // Deleting the successor requests both projections first, as the rule says.
    await h.t.run(async (ctx) => {
      const successor = (await ctx.db.get("meetings", moved.meetingId))!;
      await requestMeetingDeleteProjections(ctx, successor);
      await meetingsByStatus.delete(ctx, successor);
      await ctx.db.delete("meetings", successor._id);
    });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await projectedStatus(h, meetingId)).toBe("canceled");
    expect(await projectedStatus(h, moved.meetingId)).toBeUndefined();
  });

  it("projects the slot as moved whichever of the reschedule's webhooks lands first", async () => {
    const h = await missedMeetingHarness();
    const { meetingId } = await h.book(ORIGINAL, BOOKED_AT);
    await h.book({ key: "moved", start: "2026-10-07T15:00:00Z", oldInvitee: inviteeUri("original") }, "2026-10-03T09:00:03Z");
    await h.deliver("invitee.canceled", { ...ORIGINAL, canceled: { rescheduledTo: inviteeUri("moved") } }, "2026-10-03T09:00:00Z");

    expect(await h.meeting("original")).toMatchObject({ status: "canceled" });
    expect(await projectedStatus(h, meetingId)).toBe("moved");
  });

  it("leaves a no-show that was rebooked a no-show", async () => {
    const h = await missedMeetingHarness();
    const { opportunityId, meetingId } = await h.book(ORIGINAL, BOOKED_AT);
    await h.deliver("invitee_no_show.created", ORIGINAL, "2026-10-06T16:00:00Z");
    h.clockAt("2026-10-06T17:00:00Z");
    await h.closerActions.rescheduleLink(opportunityId, meetingId);
    await h.book(
      { key: "rebook", start: "2026-10-09T15:00:00Z", tracking: crmLinkTracking("noshow_resched", opportunityId, meetingId) },
      minutesFromNow(60),
    );

    expect(await projectedStatus(h, meetingId)).toBe("no_show");
  });
});

describe("DM bookings", () => {
  it("counts a booking rescheduled through a DM link once, in Booked Calls and on the Overview leaderboard", async () => {
    const h = await missedMeetingHarness();
    const teamId = await h.t.run((ctx) =>
      ctx.db.insert("attributionTeams", {
        tenantId: h.tenantId, slug: "team-a", displayName: "Team A", utmSource: "team-a",
        normalizedUtmSource: "team-a", isActive: true, createdAt: 0, updatedAt: 0,
      }),
    );
    const dmCloserId = await h.admin.mutation(api.attribution.dmClosers.createDmCloser, {
      teamId,
      displayName: "Dana",
      utmMedium: "dana",
    });
    // Calendly carries the booking's UTMs onto the new invitee of a reschedule.
    const tracking = { utm_source: "team-a", utm_medium: "dana" };
    const first: Booking = { ...ORIGINAL, tracking };
    await h.book(first, BOOKED_AT);
    await reschedule(h, first, { key: "moved", start: "2026-10-07T15:00:00Z", tracking }, "2026-10-03T09:00:00Z");
    expect(await h.meeting("moved")).toMatchObject({ callClassification: "new" });

    const range = { kind: "custom" as const, startBusinessDate: "2026-10-02", endBusinessDateInclusive: "2026-10-03" };
    const dashboard = await h.admin.query(api.operations.bookedCallsDashboard.getBookedCallsDashboard, { range });
    expect(dashboard.totalBooked).toBe(1);
    expect(dashboard.dmClosers.find((row) => row.key === dmCloserId)).toMatchObject({ booked: 1 });

    const leaderboard = await h.admin.query(api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows, {
      kind: "dm_closers",
      range,
    });
    if (!("kind" in leaderboard) || leaderboard.kind !== "dm_closers") throw new Error("Expected the DM closer leaderboard");
    expect(leaderboard.rows.find((row) => row.displayName === "Dana")).toMatchObject({ booked: 1 });
  });
});
