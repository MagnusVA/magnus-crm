/**
 * The call-type re-check (docs/reviews/reports-decisions.html, D5): a write
 * that can change which calls on a deal come after a held one re-types the
 * deal, through the same side effects as any meeting write.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { moveMeetingToOpportunity } from "../leads/repointLeadReferences";
import { meetingsByStatus } from "../reporting/aggregates";
import { insertMeetingAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";
import { retypeDealMeetings } from "./dealCallTypes";
import { completeMeetingForOutcome } from "./meetingOutcomeCompletion";
import { patchMeetingLifecycle } from "./meetingLifecycle";

afterEach(() => vi.useRealTimers());

const NOW = Date.parse("2026-10-10T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Harness = Awaited<ReturnType<typeof bookingHarness>>;
type CallType = NonNullable<Doc<"meetings">["callClassification"]>;

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  const closerId = await harness.t.run(async (ctx) => {
    const closer = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
      .unique();
    return closer!._id;
  });
  return { ...harness, closerId };
}

async function deal(ctx: MutationCtx, h: Harness & { closerId: Id<"users"> }) {
  const leadId = await ctx.db.insert("leads", {
    tenantId: h.tenantId, ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0,
  });
  const opportunityId = await ctx.db.insert("opportunities", {
    tenantId: h.tenantId, leadId, stage: "booked", outcome: "open", source: "calendly",
    assignedCloserId: h.closerId, createdAt: 0, updatedAt: 0,
  });
  await insertOpportunityAggregate(ctx, opportunityId);
  return opportunityId;
}

let meetingIndex = 0;
/** A meeting written the way a booking writes it, with its aggregate. */
async function meeting(
  ctx: MutationCtx,
  h: Harness & { closerId: Id<"users"> },
  opportunityId: Id<"opportunities">,
  scheduledAt: number,
  status: Doc<"meetings">["status"],
  callClassification?: CallType,
) {
  meetingIndex += 1;
  const meetingId = await ctx.db.insert("meetings", {
    tenantId: h.tenantId, opportunityId, assignedCloserId: h.closerId,
    calendlyEventUri: `https://api.calendly.com/scheduled_events/m${meetingIndex}`,
    calendlyInviteeUri: `https://api.calendly.com/scheduled_events/m${meetingIndex}/invitees/person`,
    scheduledAt, durationMinutes: 30, status, createdAt: scheduledAt - DAY,
    ...(status === "held" ? { heldMarkedAt: scheduledAt + HOUR } : {}),
    ...(callClassification ? { callClassification } : {}),
  });
  await insertMeetingAggregate(ctx, meetingId);
  return meetingId;
}

async function types(h: Harness, ids: Id<"meetings">[]) {
  return await h.t.run(async (ctx) =>
    await Promise.all(ids.map(async (id) => (await ctx.db.get("meetings", id))?.callClassification)),
  );
}

/** The meetingsByStatus count under one closer, type and status. */
async function aggregateCount(h: Harness & { closerId: Id<"users"> }, type: CallType, status: Doc<"meetings">["status"]) {
  return await h.t.run((ctx) =>
    meetingsByStatus.count(ctx, { namespace: h.tenantId, bounds: { prefix: [h.closerId, type, status] } }),
  );
}

describe("the call-type re-check", () => {
  it("makes a call booked before the first call's result a follow-up once that call is held", async () => {
    const h = await setup();
    const { first, second } = await h.t.run(async (ctx) => {
      const opportunityId = await deal(ctx, h);
      // The follow-up is booked during the first call, before its result.
      const first = await meeting(ctx, h, opportunityId, NOW - 2 * HOUR, "scheduled", "new");
      const second = await meeting(ctx, h, opportunityId, NOW + 3 * DAY, "scheduled", "new");
      return { first, second };
    });
    expect(await aggregateCount(h, "new", "scheduled")).toBe(2);

    await h.t.run(async (ctx) => {
      const row = (await ctx.db.get("meetings", first))!;
      await completeMeetingForOutcome(ctx, {
        meetingId: first,
        opportunityId: row.opportunityId,
        toMeetingStatus: "held",
        recordedAt: NOW,
      });
    });

    expect(await types(h, [first, second])).toEqual(["new", "follow_up"]);
    // The aggregate follows the patch: one first call held, one follow-up waiting.
    expect(await aggregateCount(h, "new", "held")).toBe(1);
    expect(await aggregateCount(h, "new", "scheduled")).toBe(0);
    expect(await aggregateCount(h, "follow_up", "scheduled")).toBe(1);
  });

  it("turns the later calls back into first calls when a held call is corrected to a no-show", async () => {
    const h = await setup();
    const { held, later, latest } = await h.t.run(async (ctx) => {
      const opportunityId = await deal(ctx, h);
      const held = await meeting(ctx, h, opportunityId, NOW - 3 * DAY, "held", "new");
      const later = await meeting(ctx, h, opportunityId, NOW - DAY, "no_show", "follow_up");
      const latest = await meeting(ctx, h, opportunityId, NOW + DAY, "scheduled", "follow_up");
      return { held, later, latest };
    });

    const after = await h.t.run((ctx) =>
      patchMeetingLifecycle(ctx, held, { status: "no_show", heldMarkedAt: undefined, noShowMarkedAt: NOW }),
    );

    expect(after.status).toBe("no_show");
    expect(await types(h, [held, later, latest])).toEqual(["new", "new", "new"]);
    expect(await aggregateCount(h, "follow_up", "no_show")).toBe(0);
    expect(await aggregateCount(h, "follow_up", "scheduled")).toBe(0);
    expect(await aggregateCount(h, "new", "no_show")).toBe(2);
    expect(await aggregateCount(h, "new", "scheduled")).toBe(1);
  });

  it("re-types a call moved in time, and returns it with its new type", async () => {
    const h = await setup();
    const { held, moved } = await h.t.run(async (ctx) => {
      const opportunityId = await deal(ctx, h);
      const held = await meeting(ctx, h, opportunityId, NOW - DAY, "held", "new");
      const moved = await meeting(ctx, h, opportunityId, NOW + DAY, "scheduled", "follow_up");
      return { held, moved };
    });

    // Moved to before the held call: nothing held comes before it now.
    const after = await h.t.run((ctx) => patchMeetingLifecycle(ctx, moved, { scheduledAt: NOW - 2 * DAY }));

    expect(after.callClassification).toBe("new");
    expect(await types(h, [held, moved])).toEqual(["new", "new"]);
  });

  it("leaves the types alone when attendance doesn't change whether a call is held", async () => {
    const h = await setup();
    const { first, second } = await h.t.run(async (ctx) => {
      const opportunityId = await deal(ctx, h);
      // A stored type the rule disagrees with, so a re-type would show.
      const first = await meeting(ctx, h, opportunityId, NOW - DAY, "scheduled", "new");
      const second = await meeting(ctx, h, opportunityId, NOW + DAY, "scheduled", "follow_up");
      return { first, second };
    });

    await h.t.run((ctx) => patchMeetingLifecycle(ctx, first, { status: "canceled", canceledAt: NOW }));

    expect(await types(h, [first, second])).toEqual(["new", "follow_up"]);
  });
});

describe("retypeDealMeetings", () => {
  it("returns each change, fills a missing type, and keeps the aggregate in step", async () => {
    const h = await setup();
    const ids = await h.t.run(async (ctx) => {
      const opportunityId = await deal(ctx, h);
      // The old rule: anything after the first meeting is a follow-up.
      const moved = await meeting(ctx, h, opportunityId, NOW - 3 * DAY, "canceled", "new");
      const held = await meeting(ctx, h, opportunityId, NOW - 2 * DAY, "held", "follow_up");
      const after = await meeting(ctx, h, opportunityId, NOW + DAY, "scheduled", "follow_up");
      const untyped = await meeting(ctx, h, opportunityId, NOW + 2 * DAY, "scheduled");
      return { opportunityId, moved, held, after, untyped };
    });

    const result = await h.t.run((ctx) => retypeDealMeetings(ctx, ids.opportunityId));

    expect(result.changed).toEqual([
      { meetingId: ids.held, from: "follow_up", to: "new" },
      { meetingId: ids.untyped, from: undefined, to: "follow_up" },
    ]);
    expect(await types(h, [ids.moved, ids.held, ids.after, ids.untyped])).toEqual(["new", "new", "follow_up", "follow_up"]);
    expect(await aggregateCount(h, "new", "held")).toBe(1);
    expect(await aggregateCount(h, "follow_up", "held")).toBe(0);
    expect(await aggregateCount(h, "follow_up", "scheduled")).toBe(2);
    // A second run finds nothing to change.
    expect(await h.t.run((ctx) => retypeDealMeetings(ctx, ids.opportunityId))).toEqual({ changed: [] });
  });
});

describe("a meeting moved to another deal", () => {
  it("takes its type from the deal it joins, and both deals are re-typed", async () => {
    const h = await setup();
    const ids = await h.t.run(async (ctx) => {
      const from = await deal(ctx, h);
      const to = await deal(ctx, h);
      const held = await meeting(ctx, h, from, NOW - 3 * DAY, "held", "new");
      const leftBehind = await meeting(ctx, h, from, NOW + DAY, "scheduled", "follow_up");
      const joinedEarlier = await meeting(ctx, h, to, NOW - 4 * DAY, "held", "new");
      const joinedLater = await meeting(ctx, h, to, NOW + 2 * DAY, "scheduled", "new");
      return { from, to, held, leftBehind, joinedEarlier, joinedLater };
    });

    await h.t.run((ctx) =>
      moveMeetingToOpportunity(ctx, {
        tenantId: h.tenantId,
        meetingId: ids.held,
        toOpportunityId: ids.to,
        leadName: "Other",
      }),
    );

    // The source deal has no held call left; the joined deal held one before
    // the moved call and before its own later call.
    expect(await types(h, [ids.leftBehind])).toEqual(["new"]);
    expect(await types(h, [ids.joinedEarlier, ids.held, ids.joinedLater])).toEqual(["new", "follow_up", "follow_up"]);
    expect(await aggregateCount(h, "follow_up", "held")).toBe(1);
    expect(await aggregateCount(h, "follow_up", "scheduled")).toBe(1);
    expect(await aggregateCount(h, "new", "scheduled")).toBe(1);
  });
});
