import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { migrations } from "../migrations";
import { planStuckLink } from "./stuckSchedulingLinks";
import { insertMeetingAggregate } from "../reporting/writeHooks";
import { insertLatestMeeting } from "../../tests/dealStageFixtures";
import {
  crmLinkTracking,
  minutesFromNow,
  missedMeetingHarness,
} from "../../tests/missedMeetingFixtures";
import {
  guardDealIn,
  guardHarness,
  readGuardDeal,
  type GuardHarness,
  type GuardState,
} from "../../tests/dealGuardFixtures";

// The one-off backfill for scheduling links left pending on a deal that never
// moved, before generating a link moved the deal at once
// (closer/stuckSchedulingLinks.ts, migrations.ts).

afterEach(() => vi.useRealTimers());

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Every seeded link is created at 1_200 (insertGuardTask).
const LINK_AT = 1_200;

const state = (label: string, fields: Omit<GuardState, "label" | "source">): GuardState => ({
  label,
  source: "calendly",
  ...fields,
});
const bookedWithLink = state("booked with a link", { status: "scheduled", task: "scheduling_link" });

async function meetingOn(
  harness: GuardHarness,
  opportunityId: Id<"opportunities">,
  fields: { status: "scheduled" | "held"; scheduledAt: number; createdAt?: number },
) {
  return await harness.t.run(async (ctx) => {
    const meetingId = await insertLatestMeeting(ctx, opportunityId, {
      status: fields.status,
      scheduledAt: fields.scheduledAt,
      createdAt: fields.createdAt ?? Math.min(fields.scheduledAt, 500),
      ...(fields.status === "held" ? { heldMarkedAt: fields.scheduledAt + 60 } : {}),
    });
    await insertMeetingAggregate(ctx, meetingId);
    return meetingId;
  });
}

async function seed(harness: GuardHarness) {
  const deal = async (s: GuardState) => (await guardDealIn(harness, s)).opportunityId;
  const deals = {
    // Stuck: their deals move to Follow-up.
    booked: await deal(bookedWithLink),
    bookedRecorded: await deal(bookedWithLink),
    earlyOutcome: await deal(bookedWithLink),
    callHeld: (
      await guardDealIn(harness, {
        label: "side deal at Call held with a link",
        status: "scheduled",
        source: "side_deal",
        task: "scheduling_link",
      })
    ).opportunityId,
    // Superseded: the deal moved on after the link, so it stays Booked.
    afterBookedLink: await deal(bookedWithLink),
    afterLaterMeeting: await deal(bookedWithLink),
    withUpcomingCall: await deal(bookedWithLink),
    // Not candidates.
    followUp: await deal(state("follow-up with a link", { status: "follow_up_scheduled", task: "scheduling_link" })),
    noShow: await deal(state("no-show with a stale reschedule link", { status: "no_show", task: "reschedule_link" })),
    bookedWithReminder: await deal(state("booked with a reminder", { status: "scheduled", task: "reminder" })),
    bookedNoTask: await deal(state("booked with no task", { status: "scheduled" })),
  };
  const meetings = {
    // The unrecorded call the link followed, and an older one.
    followed: await meetingOn(harness, deals.booked, { status: "scheduled", scheduledAt: 1_000 }),
    older: await meetingOn(harness, deals.booked, { status: "scheduled", scheduledAt: 500 }),
    // The call before this deal's link is already recorded.
    recorded: await meetingOn(harness, deals.bookedRecorded, { status: "held", scheduledAt: 1_000 }),
    // A link generated 2 minutes before its call (the outcome opens 5 minutes before).
    early: await meetingOn(harness, deals.earlyOutcome, {
      status: "scheduled",
      scheduledAt: LINK_AT + 2 * MINUTE,
    }),
    // A meeting created after the link: the person booked again.
    later: await meetingOn(harness, deals.afterLaterMeeting, {
      status: "scheduled",
      scheduledAt: 3_000,
      createdAt: 3_000,
    }),
    // A call still to come.
    upcoming: await meetingOn(harness, deals.withUpcomingCall, {
      status: "scheduled",
      scheduledAt: Date.now() + DAY,
      createdAt: 1_000,
    }),
  };
  // Another link on the deal was booked after this one.
  const bookedLink = await harness.t.run(async (ctx) => {
    const deal = (await ctx.db.get("opportunities", deals.afterBookedLink))!;
    return await ctx.db.insert("followUps", {
      tenantId: deal.tenantId,
      opportunityId: deal._id,
      leadId: deal.leadId,
      closerId: deal.assignedCloserId!,
      type: "scheduling_link",
      reason: "closer_initiated",
      status: "booked",
      bookedAt: 3_000,
      createdAt: 1_100,
    });
  });
  return { deals, meetings, bookedLink };
}

async function pendingLinkOf(harness: GuardHarness, opportunityId: Id<"opportunities">) {
  return await harness.t.run(async (ctx) => {
    const row = await ctx.db
      .query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) =>
        q.eq("opportunityId", opportunityId).eq("status", "pending"),
      )
      .first();
    return row!._id;
  });
}

async function stagesOf(harness: GuardHarness, deals: Record<string, Id<"opportunities">>) {
  const out: Record<string, string> = {};
  for (const [key, id] of Object.entries(deals)) {
    const deal = await readGuardDeal(harness, id);
    out[key] = `${deal.stage}/${deal.outcome}`;
  }
  return out;
}

async function meetingStatus(harness: GuardHarness, meetingId: Id<"meetings">) {
  const meeting = await harness.t.run((ctx) => ctx.db.get("meetings", meetingId));
  return { status: meeting!.status, heldMarkedAt: meeting!.heldMarkedAt };
}

async function runMigration(harness: GuardHarness, name: string, options: { dryRun?: boolean } = {}) {
  await harness.t.mutation(internal.migrations.run, {
    fn: `migrations:${name}`,
    ...(options.dryRun ? { dryRun: true } : {}),
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [status] = await harness.t.run((ctx) =>
    migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
  );
  return status;
}

async function setup() {
  vi.useFakeTimers();
  const harness = await guardHarness();
  migrationsTest.register(harness.t);
  return { harness, ...(await seed(harness)) };
}

describe("moveStuckSchedulingLinksToFollowUp", () => {
  it("previews read only: the deals it moves with their meetings, and the superseded links", async () => {
    const { harness, deals, meetings } = await setup();
    const before = await stagesOf(harness, deals);

    const preview = await harness.t.query(internal.migrations.previewStuckSchedulingLinks, {});

    expect(preview.isDone).toBe(true);
    const row = (id: Id<"opportunities">) => preview.stuck.find((r) => r.opportunityId === id);
    expect(preview.stuck.map((r) => r.opportunityId).sort()).toEqual(
      [deals.booked, deals.bookedRecorded, deals.earlyOutcome, deals.callHeld].sort(),
    );
    expect(preview.count).toBe(4);
    expect(preview.meetingsToHold).toBe(2);
    expect(row(deals.booked)).toMatchObject({
      followUpId: await pendingLinkOf(harness, deals.booked),
      stage: "booked",
      followedMeetingId: meetings.followed,
      followedMeetingStatus: "scheduled",
      heldMeetingId: meetings.followed,
    });
    expect(row(deals.bookedRecorded)).toMatchObject({
      followedMeetingId: meetings.recorded,
      followedMeetingStatus: "held",
      heldMeetingId: null,
    });
    // The call 2 minutes after the link is the one it followed.
    expect(row(deals.earlyOutcome)).toMatchObject({
      followedMeetingId: meetings.early,
      heldMeetingId: meetings.early,
    });
    expect(row(deals.callHeld)).toMatchObject({
      stage: "call_held",
      followedMeetingId: null,
      heldMeetingId: null,
    });

    expect(preview.supersededCount).toBe(3);
    expect(
      Object.fromEntries(preview.superseded.map((r) => [r.opportunityId, r.supersededBy])),
    ).toEqual({
      [deals.afterBookedLink]: "booked_follow_up",
      [deals.afterLaterMeeting]: "later_meeting",
      [deals.withUpcomingCall]: "upcoming_meeting",
    });

    expect(await stagesOf(harness, deals)).toEqual(before);
    expect((await meetingStatus(harness, meetings.followed)).status).toBe("scheduled");

    // Paged: one row at a time still finds them all.
    let cursor: string | null = null;
    let found = 0;
    let superseded = 0;
    for (let page = 0; page < 40; page += 1) {
      const result: { count: number; supersededCount: number; isDone: boolean; continueCursor: string } =
        await harness.t.query(internal.migrations.previewStuckSchedulingLinks, {
          cursor,
          numItems: 1,
        });
      found += result.count;
      superseded += result.supersededCount;
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect({ found, superseded }).toEqual({ found: 4, superseded: 3 });
  });

  it("a dry run of the migration changes nothing", async () => {
    const { harness, deals, meetings } = await setup();
    const before = await stagesOf(harness, deals);

    await runMigration(harness, "moveStuckSchedulingLinksToFollowUp", { dryRun: true });

    expect(await stagesOf(harness, deals)).toEqual(before);
    expect((await meetingStatus(harness, meetings.followed)).status).toBe("scheduled");
    const preview = await harness.t.query(internal.migrations.previewStuckSchedulingLinks, {});
    expect({ count: preview.count, superseded: preview.supersededCount }).toEqual({
      count: 4,
      superseded: 3,
    });
  });

  it("moves the stuck deals, holds their unrecorded calls, expires superseded links, and the assert passes", async () => {
    const { harness, deals, meetings, bookedLink } = await setup();
    expect((await runMigration(harness, "assertNoStuckSchedulingLinks"))?.state).toBe("failed");
    const recordedBefore = await meetingStatus(harness, meetings.recorded);
    const supersededLinks = {
      afterBookedLink: await pendingLinkOf(harness, deals.afterBookedLink),
      afterLaterMeeting: await pendingLinkOf(harness, deals.afterLaterMeeting),
      withUpcomingCall: await pendingLinkOf(harness, deals.withUpcomingCall),
    };

    expect((await runMigration(harness, "moveStuckSchedulingLinksToFollowUp"))?.isDone).toBe(true);

    expect(await stagesOf(harness, deals)).toEqual({
      booked: "follow_up/open",
      bookedRecorded: "follow_up/open",
      earlyOutcome: "follow_up/open",
      callHeld: "follow_up/open",
      afterBookedLink: "booked/open",
      afterLaterMeeting: "booked/open",
      withUpcomingCall: "booked/open",
      followUp: "follow_up/open",
      noShow: "closed/lost",
      bookedWithReminder: "booked/open",
      bookedNoTask: "booked/open",
    });
    // A moved deal's link stays pending for a booking to find.
    const link = await pendingLinkOf(harness, deals.booked);
    expect((await harness.t.run((ctx) => ctx.db.get("followUps", link)))!.status).toBe("pending");
    // The unrecorded call each link followed is held, the 2-minutes-early one
    // included; an older call and a call already recorded are left alone.
    expect(await meetingStatus(harness, meetings.followed)).toEqual({
      status: "held",
      heldMarkedAt: expect.any(Number),
    });
    expect((await meetingStatus(harness, meetings.early)).status).toBe("held");
    expect((await meetingStatus(harness, meetings.older)).status).toBe("scheduled");
    expect(await meetingStatus(harness, meetings.recorded)).toEqual(recordedBefore);
    // A superseded deal's leftover link is expired, with its event; the
    // later and upcoming calls and the booked link are untouched.
    for (const followUpId of Object.values(supersededLinks)) {
      const followUp = await harness.t.run((ctx) => ctx.db.get("followUps", followUpId));
      expect(followUp!.status).toBe("expired");
      const events = await harness.t.run((ctx) =>
        ctx.db
          .query("domainEvents")
          .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
            q.eq("tenantId", harness.tenantId).eq("entityType", "followUp").eq("entityId", followUpId),
          )
          .take(5),
      );
      expect(events.map((event) => [event.eventType, event.source])).toEqual([
        ["followUp.expired", "system"],
      ]);
    }
    expect((await meetingStatus(harness, meetings.later)).status).toBe("scheduled");
    expect((await meetingStatus(harness, meetings.upcoming)).status).toBe("scheduled");
    expect((await harness.t.run((ctx) => ctx.db.get("followUps", bookedLink)))!.status).toBe("booked");
    // One system stage change per moved deal.
    const dealEvents = await harness.t.run((ctx) =>
      ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
          q.eq("tenantId", harness.tenantId).eq("entityType", "opportunity").eq("entityId", deals.booked),
        )
        .take(10),
    );
    expect(
      dealEvents.map((event) => [event.eventType, event.fromStatus, event.toStatus, event.source]),
    ).toEqual([["opportunity.stage_changed", "booked", "follow_up", "system"]]);

    expect((await runMigration(harness, "assertNoStuckSchedulingLinks"))?.isDone).toBe(true);
    const after = await harness.t.query(internal.migrations.previewStuckSchedulingLinks, {});
    expect({ count: after.count, superseded: after.supersededCount }).toEqual({ count: 0, superseded: 0 });
  });
});

describe("a deal rebooked through one of two links", () => {
  it("stays Booked: the leftover link is superseded and expired, not moved to Follow-up", async () => {
    const h = await missedMeetingHarness();
    const { opportunityId, meetingId } = await h.book(
      { key: "original", start: "2026-10-06T15:00:00Z" },
      "2026-10-02T10:00:00Z",
    );
    // The old dialog could leave two links on one deal: this one moved it,
    h.clockAt("2026-10-06T15:40:00Z");
    const used = await h.closerActions.schedulingLink(opportunityId, meetingId);
    // and a second Generate left another pending.
    const leftover = await h.closerActions.legacyUnconfirmedSchedulingLink(opportunityId);

    await h.book(
      {
        key: "rebook",
        start: "2026-10-12T15:00:00Z",
        tracking: crmLinkTracking("follow_up", opportunityId, used),
      },
      minutesFromNow(60),
    );
    expect(await h.deal(opportunityId)).toMatchObject({ stage: "booked", outcome: "open" });
    expect((await h.followUps(opportunityId)).find((f) => f._id === leftover)?.status).toBe("pending");

    const preview = await h.t.query(internal.migrations.previewStuckSchedulingLinks, {});
    expect(preview.count).toBe(0);
    expect(preview.superseded).toEqual([
      expect.objectContaining({ followUpId: leftover, opportunityId, supersededBy: "booked_follow_up" }),
    ]);

    expect((await h.runMigration("moveStuckSchedulingLinksToFollowUp"))?.isDone).toBe(true);

    expect(await h.deal(opportunityId)).toMatchObject({ stage: "booked", outcome: "open" });
    expect(await h.meeting("rebook")).toMatchObject({ status: "scheduled", opportunityId });
    const links = await h.followUps(opportunityId);
    expect(links.find((f) => f._id === used)?.status).toBe("booked");
    expect(links.find((f) => f._id === leftover)?.status).toBe("expired");
    expect((await h.runMigration("assertNoStuckSchedulingLinks"))?.isDone).toBe(true);
  });
});

describe("a link generated in the early-outcome window", () => {
  it("is still stuck while its own call is still to come: the deal moves and that call is held", async () => {
    const { harness, deals, meetings } = await setup();
    const linkId = await pendingLinkOf(harness, deals.earlyOutcome);

    // The backfill runs a minute after the link, before its call starts.
    const plan = await harness.t.run(async (ctx) =>
      planStuckLink(ctx, (await ctx.db.get("followUps", linkId))!, LINK_AT + MINUTE),
    );

    expect(plan).toMatchObject({ kind: "move", heldMeetingId: meetings.early });
  });

  it("is still superseded by another call to come", async () => {
    const { harness, deals } = await setup();
    await meetingOn(harness, deals.earlyOutcome, {
      status: "scheduled",
      scheduledAt: LINK_AT + DAY,
      createdAt: 1_000,
    });
    const linkId = await pendingLinkOf(harness, deals.earlyOutcome);

    const plan = await harness.t.run(async (ctx) =>
      planStuckLink(ctx, (await ctx.db.get("followUps", linkId))!, LINK_AT + MINUTE),
    );

    expect(plan).toMatchObject({ kind: "superseded", reason: "upcoming_meeting" });
  });
});
