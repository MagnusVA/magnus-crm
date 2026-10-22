import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { vi } from "vitest";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import type { OpportunityStatus } from "../convex/lib/statusTransitions";
import type { DealSource } from "../convex/opportunities/stages";
import { bookingHarness } from "./bookingHarness";
import { insertDeal, type DealFields } from "./dealStageFixtures";
import { insertPayment, insertProgram } from "./enrollmentFixtures";

// The report numbers both ways (docs/plans/phase-5-deal-status.md §10.4): a
// small tenant with a deal at every status, two closers, meetings with every
// outcome the team report derives, and losses by a person and by the system.

export const NOW = Date.UTC(2026, 9, 20, 12);
export const DAY = 86_400_000;

export function daysAgo(days: number): number {
  return NOW - days * DAY;
}

/** The losses Pipeline Health counts: the last 30 days. */
export const LOSS_RANGE = { startDate: daysAgo(30), endDate: NOW };

/** The meetings the team report and the closer strip count. */
export const MEETING_RANGE = { startDate: daysAgo(60), endDate: NOW + 7 * DAY };

export type ParityHarness = Awaited<ReturnType<typeof parityHarness>>;

/** The booking harness at NOW, with a second closer. */
export async function parityHarness() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  const users = await harness.t.run(async (ctx) => {
    const byWorkosId = async (workosUserId: string) =>
      (await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
        .unique())!._id;
    const closerBId = await ctx.db.insert("users", {
      tenantId: harness.tenantId,
      workosUserId: "user_closer_b",
      email: "closer-b@example.com",
      role: "closer",
      isActive: true,
    });
    return {
      adminId: await byWorkosId("user_admin"),
      closerAId: await byWorkosId("user_closer"),
      closerBId,
    };
  });
  return { ...harness, ...users };
}

type DealSpec = {
  status: OpportunityStatus;
  source: DealSource;
  closer?: "A" | "B";
  fields: DealFields;
};

type MeetingSpec = {
  deal: DealName;
  closer: "A" | "B";
  status: Doc<"meetings">["status"];
  scheduledAt: number;
  // An earlier meeting's name.
  rescheduledFrom?: string;
};

// Every status, with the cases each report treats apart: the side deal
// (Call held), a stale-expired Slack deal, a missed meeting's loss, a loss
// before the range, and losses by a closer, by an admin and by nobody known.
const DEALS = {
  qualified: { status: "qualified_pending", source: "slack_qualified", fields: { createdAt: daysAgo(5) } },
  bookedStale: {
    status: "scheduled",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(40), nextMeetingAt: daysAgo(20) },
  },
  bookedUpcoming: {
    status: "scheduled",
    source: "calendly",
    closer: "B",
    fields: { createdAt: daysAgo(3), nextMeetingAt: NOW + DAY },
  },
  sideDeal: { status: "scheduled", source: "side_deal", closer: "A", fields: { createdAt: daysAgo(10) } },
  followUp: {
    status: "follow_up_scheduled",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(30), nextMeetingAt: daysAgo(2) },
  },
  linkSent: { status: "reschedule_link_sent", source: "calendly", closer: "B", fields: { createdAt: daysAgo(25) } },
  won: {
    status: "payment_received",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(20), paymentReceivedAt: daysAgo(15) },
  },
  wonOld: {
    status: "payment_received",
    source: "side_deal",
    closer: "B",
    fields: { createdAt: daysAgo(100), paymentReceivedAt: daysAgo(95) },
  },
  lostByCloser: {
    status: "lost",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(12), lostReason: "Budget", lostAt: daysAgo(2), latestActivityAt: daysAgo(2) },
  },
  lostByAdmin: {
    status: "lost",
    source: "calendly",
    closer: "B",
    fields: { createdAt: daysAgo(9), lostAt: daysAgo(1), latestActivityAt: daysAgo(1) },
  },
  lostUnknown: {
    status: "lost",
    source: "slack_qualified",
    closer: "B",
    fields: { createdAt: daysAgo(14), lostReason: "Went quiet", lostAt: daysAgo(3), latestActivityAt: daysAgo(3) },
  },
  stale: {
    status: "lost",
    source: "slack_qualified",
    fields: { createdAt: daysAgo(36), lostReason: "stale", lostAt: daysAgo(4), latestActivityAt: daysAgo(35) },
  },
  canceled: {
    status: "canceled",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(8), lostReason: "canceled", lostAt: daysAgo(2), latestActivityAt: daysAgo(2) },
  },
  noShow: {
    status: "no_show",
    source: "calendly",
    closer: "B",
    fields: { createdAt: daysAgo(11), lostReason: "no_show", lostAt: daysAgo(6), latestActivityAt: daysAgo(6) },
  },
  lostEarlier: {
    status: "lost",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(45), lostReason: "Timing", lostAt: daysAgo(40), latestActivityAt: daysAgo(1) },
  },
} satisfies Record<string, DealSpec>;

export type DealName = keyof typeof DEALS;

// In time order per deal; the last one on a deal is its latest.
const MEETINGS = {
  lostEarlier: { deal: "lostEarlier", closer: "A", status: "completed", scheduledAt: daysAgo(41) },
  followUp: { deal: "followUp", closer: "A", status: "completed", scheduledAt: daysAgo(29) },
  linkSentHeld: { deal: "linkSent", closer: "B", status: "completed", scheduledAt: daysAgo(26) },
  linkSent: { deal: "linkSent", closer: "B", status: "no_show", scheduledAt: daysAgo(24) },
  bookedStale: { deal: "bookedStale", closer: "A", status: "scheduled", scheduledAt: daysAgo(20) },
  won: { deal: "won", closer: "A", status: "completed", scheduledAt: daysAgo(18) },
  lostByCloserEarly: { deal: "lostByCloser", closer: "A", status: "completed", scheduledAt: daysAgo(10) },
  lostUnknown: { deal: "lostUnknown", closer: "B", status: "completed", scheduledAt: daysAgo(7) },
  noShow: { deal: "noShow", closer: "B", status: "no_show", scheduledAt: daysAgo(6) },
  lostByCloser: { deal: "lostByCloser", closer: "A", status: "completed", scheduledAt: daysAgo(5) },
  bookedUpcomingOld: { deal: "bookedUpcoming", closer: "B", status: "canceled", scheduledAt: daysAgo(4) },
  lostByAdmin: { deal: "lostByAdmin", closer: "B", status: "completed", scheduledAt: daysAgo(3) },
  canceled: { deal: "canceled", closer: "A", status: "canceled", scheduledAt: daysAgo(2) },
  bookedUpcoming: {
    deal: "bookedUpcoming",
    closer: "B",
    status: "scheduled",
    scheduledAt: NOW + DAY,
    rescheduledFrom: "bookedUpcomingOld",
  },
} satisfies Record<string, MeetingSpec>;

export type MeetingName = keyof typeof MEETINGS;

export type MixedPipeline = {
  deals: Record<DealName, Id<"opportunities">>;
  meetings: Record<MeetingName, Id<"meetings">>;
};

/** Seeds the mixed tenant: 15 deals, 14 meetings, a reschedule link, a payment. */
export async function seedMixedPipeline(harness: ParityHarness): Promise<MixedPipeline> {
  const { tenantId, adminId, closerAId, closerBId } = harness;
  const closerIds = { A: closerAId, B: closerBId };
  return await harness.t.run(async (ctx) => {
    const deals = {} as Record<DealName, Id<"opportunities">>;
    for (const [name, spec] of Object.entries(DEALS) as [DealName, DealSpec][]) {
      const createdAt = spec.fields.createdAt ?? NOW;
      deals[name] = await insertDeal(ctx, {
        tenantId,
        status: spec.status,
        source: spec.source,
        fields: {
          assignedCloserId: spec.closer ? closerIds[spec.closer] : undefined,
          updatedAt: createdAt,
          latestActivityAt: createdAt,
          ...spec.fields,
        },
      });
    }
    // Losses a person recorded.
    await ctx.db.patch("opportunities", deals.lostByCloser, { lostByUserId: closerAId });
    await ctx.db.patch("opportunities", deals.lostByAdmin, { lostByUserId: adminId });
    await ctx.db.patch("opportunities", deals.lostEarlier, { lostByUserId: closerAId });

    const meetings = {} as Record<MeetingName, Id<"meetings">>;
    for (const [name, spec] of Object.entries(MEETINGS) as [MeetingName, MeetingSpec][]) {
      meetings[name] = await insertMeeting(ctx, {
        tenantId,
        opportunityId: deals[spec.deal],
        closerId: closerIds[spec.closer],
        status: spec.status,
        scheduledAt: spec.scheduledAt,
        rescheduledFromMeetingId: spec.rescheduledFrom
          ? meetings[spec.rescheduledFrom as MeetingName]
          : undefined,
      });
    }

    await insertRescheduleLink(ctx, { tenantId, opportunityId: deals.linkSent, closerId: closerBId });
    const programId = await insertProgram(ctx, tenantId, "Program");
    await insertPayment(ctx, { tenantId, opportunityId: deals.won, programId, recordedAt: daysAgo(15) });
    return { deals, meetings };
  });
}

/** The harness with the mixed tenant seeded. */
export async function seededParityHarness(): Promise<{ harness: ParityHarness; seed: MixedPipeline }> {
  const harness = await parityHarness();
  const seed = await seedMixedPipeline(harness);
  return { harness, seed };
}

// What the mixed tenant counts, both ways.

export const noOutcomes = {
  sold: 0,
  lost: 0,
  no_show: 0,
  canceled: 0,
  rescheduled: 0,
  dq: 0,
  follow_up: 0,
  scheduled: 0,
};

export const noStatuses = {
  qualified_pending: 0,
  scheduled: 0,
  follow_up_scheduled: 0,
  reschedule_link_sent: 0,
  payment_received: 0,
  lost: 0,
  canceled: 0,
  no_show: 0,
};

export const noPositions = { qualified: 0, booked: 0, call_held: 0, follow_up: 0, won: 0, lost: 0 };

/** The team report's outcome mix for the meetings in MEETING_RANGE. */
export const closerAOutcomes = { ...noOutcomes, sold: 1, lost: 2, canceled: 1, follow_up: 1, scheduled: 2 };
export const closerBOutcomes = { ...noOutcomes, lost: 2, no_show: 2, canceled: 1, scheduled: 2 };

/** A meeting on the deal, made its latest. */
export async function insertMeeting(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    closerId: Id<"users">;
    status: Doc<"meetings">["status"];
    scheduledAt: number;
    rescheduledFromMeetingId?: Id<"meetings">;
  },
): Promise<Id<"meetings">> {
  const meetingId = await ctx.db.insert("meetings", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    assignedCloserId: args.closerId,
    calendlyEventUri: `https://api.calendly.com/scheduled_events/${args.opportunityId}-${args.scheduledAt}`,
    calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${args.opportunityId}-${args.scheduledAt}/invitees/person`,
    scheduledAt: args.scheduledAt,
    durationMinutes: 30,
    createdAt: args.scheduledAt - DAY,
    status: args.status,
    completedAt: args.status === "completed" ? args.scheduledAt + 30 * 60_000 : undefined,
    rescheduledFromMeetingId: args.rescheduledFromMeetingId,
  });
  await ctx.db.patch("opportunities", args.opportunityId, {
    latestMeetingId: meetingId,
    latestMeetingAt: args.scheduledAt,
  });
  return meetingId;
}

/** The pending reschedule link a deal at reschedule_link_sent has (§4.5). */
export async function insertRescheduleLink(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; opportunityId: Id<"opportunities">; closerId: Id<"users"> },
): Promise<Id<"followUps">> {
  const deal = (await ctx.db.get("opportunities", args.opportunityId))!;
  return await ctx.db.insert("followUps", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    leadId: deal.leadId,
    closerId: args.closerId,
    type: "scheduling_link",
    schedulingLinkUrl: "https://calendly.com/closer-b/follow-up",
    reason: "no_show_follow_up",
    status: "pending",
    createdAt: daysAgo(23),
    createdSource: "closer",
  });
}

type PagedPage = { isDone: boolean; continueCursor: unknown };

/**
 * Pages a compare query to the end, as the production runs do (§10.7), and
 * returns the last page with the number of calls it took.
 */
export async function runToEnd<Query extends FunctionReference<"query", "internal">>(
  t: ParityHarness["t"],
  query: Query,
  args: Omit<FunctionArgs<Query>, "cursor">,
  maxCalls = 200,
): Promise<{ last: FunctionReturnType<Query>; calls: number }> {
  const runQuery = t.query.bind(t) as unknown as (
    query: Query,
    args: FunctionArgs<Query>,
  ) => Promise<FunctionReturnType<Query> & PagedPage>;
  let cursor: unknown;
  for (let calls = 1; calls <= maxCalls; calls += 1) {
    const callArgs = (cursor === undefined ? args : { ...args, cursor }) as FunctionArgs<Query>;
    const page = await runQuery(query, callArgs);
    if (page.isDone) {
      return { last: page, calls };
    }
    cursor = page.continueCursor ?? undefined;
  }
  throw new Error(`Still not done after ${maxCalls} calls`);
}
