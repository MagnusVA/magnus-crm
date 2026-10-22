import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionOpportunity } from "../lib/opportunityActivity";
import { OPPORTUNITY_STATUSES } from "../lib/statusTransitions";
import {
  allowsMoveToBooked,
  bookingFactMovesDeal,
  calendlyRescheduleTarget,
  followUpJoinTargets,
  isBookingLinkTarget,
  isFollowUpJoinTarget,
  isWaitingOnRescheduleLink,
  loadDealTasks,
} from "./bookingTargets";
import {
  findOpenSlackQualifiedOpportunity,
  SLACK_JOIN_LOOKBACK_MS,
  wasStaleExpiredAfter,
} from "./slackJoinLookup";
import { bookingHarness } from "../../tests/bookingHarness";
import { harnessCloserId } from "../../tests/dealStageFixtures";
import { missedMeetingHarness } from "../../tests/missedMeetingFixtures";
import {
  DEAL_SOURCES,
  TODAYS_CHECKS,
  bookingRuleWorlds,
  insertRescheduleLink,
  insertRuleDeal,
  todaysSlackJoinCandidates,
  type BookingRuleWorld,
} from "../../tests/bookingRuleFixtures";

// Each booking rule reads the stage, outcome, loss and tasks from PR 7 and
// gives the answer today's status check gives, for every status, source,
// loss and task state the dual write leaves (docs/plans/phase-5-deal-status.md
// §4.6, §6.7). Each check lists the deals it disagrees on, so a failure
// names them.

const WORLDS = bookingRuleWorlds();

function disagreements<T>(
  now: (world: BookingRuleWorld) => T,
  today: (world: BookingRuleWorld) => T,
): string[] {
  return WORLDS.filter((world) => now(world) !== today(world)).map(
    (world) => `${world.label}: ${String(now(world))}, today ${String(today(world))}`,
  );
}

it("covers every status, source, loss and task state the dual write leaves", () => {
  for (const status of OPPORTUNITY_STATUSES)
    for (const source of DEAL_SOURCES)
      expect(WORLDS.some((w) => w.status === status && w.deal.source === source), `${status} ${source}`).toBe(true);
  // Follow-up splits on the reschedule link; the other statuses allow either.
  expect(WORLDS.some((w) => w.status === "follow_up_scheduled" && w.tasks.hasPendingRescheduleLink)).toBe(false);
  expect(WORLDS.some((w) => w.status === "reschedule_link_sent" && !w.tasks.hasPendingRescheduleLink)).toBe(false);
  expect(WORLDS.some((w) => w.status === "scheduled" && w.tasks.hasPendingRescheduleLink)).toBe(true);
  // A person's loss is `lost` whatever its text; the system's code alone is a missed meeting.
  expect(WORLDS.some((w) => w.status === "no_show" && w.deal.lostByUserId)).toBe(false);
  expect(WORLDS.some((w) => w.status === "lost" && w.deal.lostReason === "no_show")).toBe(true);
  // Deals from before the backfill, which take the stage from the status.
  expect(WORLDS.some((w) => w.deal.stage === undefined)).toBe(true);
});

describe("against today's status checks", () => {
  it("the booking link takes a Follow-up deal (today follow_up_scheduled or reschedule_link_sent)", () => {
    expect(disagreements(
      (w) => isBookingLinkTarget(w.deal),
      (w) => TODAYS_CHECKS.bookingLinkTarget(w.status),
    )).toEqual([]);
  });

  it("the booking link expires reschedule links on Follow-up with a pending one (today reschedule_link_sent)", () => {
    expect(disagreements(
      (w) => isWaitingOnRescheduleLink(w.deal, w.tasks),
      (w) => TODAYS_CHECKS.expiresRescheduleLinks(w.status),
    )).toEqual([]);
  });

  it("a Calendly reschedule moves Booked or Call held, leaves a missed meeting's deal, holds the rest", () => {
    expect(disagreements(
      (w) => calendlyRescheduleTarget(w.deal),
      (w) => TODAYS_CHECKS.calendlyRescheduleTarget(w.status),
    )).toEqual([]);
  });

  it("the follow-up join takes Follow-up with no pending reschedule link (today follow_up_scheduled)", () => {
    expect(disagreements(
      (w) => isFollowUpJoinTarget(w.deal, w.tasks),
      (w) => TODAYS_CHECKS.followUpJoinTarget(w.status),
    )).toEqual([]);
  });

  it("a booking may move Qualified, Follow-up or a missed meeting's deal (today validateTransition to scheduled)", () => {
    expect(disagreements(
      (w) => allowsMoveToBooked(w.deal),
      (w) => TODAYS_CHECKS.allowsMoveToBooked(w.status),
    )).toEqual([]);
  });

  it.each(["scheduled", "no_show", "canceled"] as const)(
    "a Calendly fact leaving the meeting %s moves Booked, Call held or a missed meeting's deal it doesn't already say",
    (meetingStatus) => {
      expect(disagreements(
        (w) => bookingFactMovesDeal(w.deal, meetingStatus),
        (w) => TODAYS_CHECKS.bookingFactMovesDeal(w.status, meetingStatus),
      )).toEqual([]);
    },
  );

  it.each([
    ["after", 1_000],
    ["before", 2_000],
  ])("the Slack join reopens a deal the stale expiry closed %s the booking", (_label, referenceTime) => {
    expect(disagreements(
      (w) => wasStaleExpiredAfter(w.deal, referenceTime),
      (w) => TODAYS_CHECKS.wasStaleExpiredAfter(w.deal, referenceTime),
    )).toEqual([]);
  });
});

describe("loadDealTasks", () => {
  it("counts a pending reschedule link and nothing else", async () => {
    const { t, tenantId } = await bookingHarness();
    await t.run(async (ctx) => {
      const { leadId, opportunityId } = await insertRuleDeal(ctx, tenantId, {
        status: "follow_up_scheduled", source: "calendly", stage: "follow_up", outcome: "open",
      });
      expect(await loadDealTasks(ctx, opportunityId)).toEqual({ hasPendingRescheduleLink: false });
      // A closer's ordinary scheduling link and a reminder aren't reschedule links.
      const closerId = await harnessCloserId(ctx);
      await ctx.db.insert("followUps", {
        tenantId, opportunityId, leadId, closerId, type: "scheduling_link",
        reason: "closer_initiated", status: "pending", createdAt: 1_000,
      });
      await ctx.db.insert("followUps", {
        tenantId, opportunityId, leadId, closerId, type: "manual_reminder",
        reason: "closer_initiated", status: "pending", createdAt: 1_000,
      });
      expect(await loadDealTasks(ctx, opportunityId)).toEqual({ hasPendingRescheduleLink: false });
      const linkId = await insertRescheduleLink(ctx, opportunityId);
      expect(await loadDealTasks(ctx, opportunityId)).toEqual({ hasPendingRescheduleLink: true });
      await ctx.db.patch("followUps", linkId, { status: "booked" });
      expect(await loadDealTasks(ctx, opportunityId)).toEqual({ hasPendingRescheduleLink: false });
    });
  });
});

describe("followUpJoinTargets", () => {
  it("takes the Follow-up deals with no pending reschedule link, in the order given", async () => {
    const { t, tenantId } = await bookingHarness();
    await t.run(async (ctx) => {
      const followUp = {
        status: "follow_up_scheduled" as const,
        source: "calendly" as const,
        stage: "follow_up" as const,
        outcome: "open" as const,
      };
      const older = await insertRuleDeal(ctx, tenantId, followUp, { createdAt: 1_000 });
      const waiting = await insertRuleDeal(ctx, tenantId, { ...followUp, status: "reschedule_link_sent" }, { createdAt: 2_000 });
      await insertRescheduleLink(ctx, waiting.opportunityId);
      const booked = await insertRuleDeal(ctx, tenantId, {
        status: "scheduled", source: "calendly", stage: "booked", outcome: "open",
      });
      const newer = await insertRuleDeal(ctx, tenantId, followUp, { createdAt: 3_000 });
      const deals = await Promise.all(
        [newer, booked, waiting, older].map(
          async ({ opportunityId }) => (await ctx.db.get("opportunities", opportunityId))!,
        ),
      );

      expect((await followUpJoinTargets(ctx, deals)).map((deal) => deal._id)).toEqual([
        newer.opportunityId,
        older.opportunityId,
      ]);
      expect((await followUpJoinTargets(ctx, deals.slice(1))).map((deal) => deal._id)).toEqual([
        older.opportunityId,
      ]);
      // A deal waiting on a reschedule link is no target.
      expect(await followUpJoinTargets(ctx, deals.slice(1, 3))).toEqual([]);
    });
  });
});

describe("findOpenSlackQualifiedOpportunity", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const REFERENCE = 40 * DAY;
  const IN_WINDOW = REFERENCE - 10 * DAY;
  const placements = [
    ["created in the window, closed after the booking", { createdAt: IN_WINDOW, lostAt: REFERENCE + 1 }],
    ["created in the window, closed before the booking", { createdAt: IN_WINDOW, lostAt: REFERENCE - 1 }],
    ["created before the window", { createdAt: REFERENCE - SLACK_JOIN_LOOKBACK_MS, lostAt: REFERENCE + 1 }],
    ["created after the booking", { createdAt: REFERENCE + 1, lostAt: REFERENCE + 2 }],
  ] as const;

  it("finds the deal today's status lookup finds, for every deal and placement", async () => {
    const { t, tenantId } = await bookingHarness();
    const mismatches: string[] = [];
    let found = 0;
    // The lookup reads the stage index, so it finds the deals with a stored
    // stage: every deal in production since PR 1's backfill (assertDealStages).
    const written = WORLDS.filter((w) => w.deal.stage !== undefined);
    for (const [placement, times] of placements)
      await t.run(async (ctx) => {
        // One person per deal, so each lookup sees one deal.
        for (const world of written) {
          const { leadId } = await insertRuleDeal(ctx, tenantId, world.deal, {
            createdAt: times.createdAt,
            ...(world.deal.lostAt !== undefined ? { lostAt: times.lostAt } : {}),
          });
          const args = { tenantId, leadId, referenceTime: REFERENCE, lookbackMs: SLACK_JOIN_LOOKBACK_MS };
          const today = (await todaysSlackJoinCandidates(ctx, args))[0] ?? null;
          const now = (await findOpenSlackQualifiedOpportunity(ctx, args))?._id ?? null;
          if (now !== today) mismatches.push(`${world.label}, ${placement}: ${now ? "found" : "none"}`);
          if (now) found++;
        }
      });
    expect(mismatches).toEqual([]);
    // Some deals are found: pending Slack deals, and stale-expired ones.
    expect(found).toBeGreaterThan(0);
  }, 60_000);

  it("blocks when two Slack deals could take the booking, as today", async () => {
    const { t, tenantId } = await bookingHarness();
    await t.run(async (ctx) => {
      const pending = await insertRuleDeal(ctx, tenantId, {
        status: "qualified_pending", source: "slack_qualified", stage: "qualified", outcome: "open",
      }, { createdAt: IN_WINDOW });
      await ctx.db.insert("opportunities", {
        tenantId, leadId: pending.leadId, status: "lost", source: "slack_qualified", stage: "closed",
        outcome: "lost", lostReason: "stale", lostAt: REFERENCE + 1, createdAt: IN_WINDOW - 1, updatedAt: 0,
      });
      const args = { tenantId, leadId: pending.leadId, referenceTime: REFERENCE };
      expect(await todaysSlackJoinCandidates(ctx, { ...args, lookbackMs: SLACK_JOIN_LOOKBACK_MS })).toHaveLength(2);
      await expect(findOpenSlackQualifiedOpportunity(ctx, args)).rejects.toThrow();
    });
  });
});

describe("a booking without a link, through the pipeline", () => {
  afterEach(() => vi.useRealTimers());

  const ORIGINAL = { key: "original", start: "2026-10-06T15:00:00Z" };
  const REBOOK = { key: "rebook", start: "2026-10-12T15:00:00Z" };

  it("doesn't join a Follow-up deal waiting on a reschedule link, and leaves the link pending", async () => {
    const h = await missedMeetingHarness();
    const { opportunityId, meetingId } = await h.book(ORIGINAL, "2026-10-02T10:00:00Z");
    await h.deliver("invitee_no_show.created", ORIGINAL, "2026-10-06T16:00:00Z");
    h.clockAt("2026-10-06T17:00:00Z");
    const linkId = await h.closerActions.rescheduleLink(opportunityId, meetingId);
    expect(await h.deal(opportunityId)).toMatchObject({ status: "reschedule_link_sent", stage: "follow_up" });

    const next = await h.book(REBOOK, "2026-10-08T10:00:00Z");

    expect(next.opportunityId).not.toBe(opportunityId);
    expect(await h.deal(opportunityId)).toMatchObject({ status: "reschedule_link_sent", stage: "follow_up" });
    expect((await h.followUps(opportunityId)).find((f) => f._id === linkId)).toMatchObject({ status: "pending" });
  });

  it("joins a Follow-up deal with no reschedule link", async () => {
    const h = await missedMeetingHarness();
    const { opportunityId } = await h.book(ORIGINAL, "2026-10-02T10:00:00Z");
    h.clockAt("2026-10-06T17:00:00Z");
    await h.t.run((ctx) => transitionOpportunity(ctx, opportunityId, {
      to: "follow_up_scheduled", source: "closer", occurredAt: Date.now(), fields: { updatedAt: Date.now() },
    }));

    const next = await h.book(REBOOK, "2026-10-08T10:00:00Z");

    expect(next.opportunityId).toBe(opportunityId);
    expect(await h.deal(opportunityId)).toMatchObject({ status: "scheduled", stage: "booked" });
    expect(await h.dealCount()).toBe(1);
  });
});
