import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import type { OpportunityStatus } from "../convex/lib/statusTransitions";
import type { DealSource } from "../convex/opportunities/stages";
import { bookingHarness } from "./bookingHarness";
import { insertDeal, type DealFields } from "./dealStageFixtures";

// The closer's pipeline, dashboard strip and calendar read the deal's stage
// and outcome (docs/plans/phase-5-deal-status.md §6.2, §6.3): one closer's
// deals at every position, a second closer's deal, and their meetings and
// tasks.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The start of the period the tests filter on, a day long. */
export const T0 = Date.UTC(2026, 9, 1);
export const PERIOD = { periodStart: T0, periodEnd: T0 + DAY };

/** The meetings the strip and the calendar count: a week from T0. */
export const MEETING_RANGE = { startDate: T0, endDate: T0 + 7 * DAY };

export type CloserPipelineHarness = Awaited<ReturnType<typeof closerPipelineHarness>>;

/** The booking harness, with its closer and a second closer. */
export async function closerPipelineHarness() {
  const harness = await bookingHarness();
  const ids = await harness.t.run(async (ctx) => {
    const closer = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
      .unique();
    const otherCloserId = await ctx.db.insert("users", {
      tenantId: harness.tenantId,
      workosUserId: "user_closer_other",
      email: "other-closer@example.com",
      role: "closer",
      isActive: true,
    });
    return { closerId: closer!._id, otherCloserId };
  });
  return { ...harness, ...ids };
}

/** A deal of the closer's at `status`, created (and last updated) at `createdAt`. */
export async function insertCloserDeal(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    closerId: Id<"users">;
    status: OpportunityStatus;
    source?: DealSource;
    createdAt: number;
    fields?: DealFields;
  },
): Promise<Id<"opportunities">> {
  return await insertDeal(ctx, {
    tenantId: args.tenantId,
    status: args.status,
    source: args.source,
    fields: {
      assignedCloserId: args.closerId,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
      ...args.fields,
    },
  });
}

/** A meeting on the deal, with the closer, made its latest. */
export async function insertCloserMeeting(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    closerId: Id<"users">;
    status: Doc<"meetings">["status"];
    scheduledAt: number;
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
    leadName: "Deal Person",
  });
  await ctx.db.patch("opportunities", args.opportunityId, {
    latestMeetingId: meetingId,
    latestMeetingAt: args.scheduledAt,
  });
  return meetingId;
}

/** A task on the deal: a reminder, a scheduling link or a reschedule link. */
export async function insertTask(
  ctx: MutationCtx,
  args: {
    opportunityId: Id<"opportunities">;
    type: Doc<"followUps">["type"];
    reason: Doc<"followUps">["reason"];
    status: Doc<"followUps">["status"];
    reminderScheduledAt?: number;
  },
): Promise<Id<"followUps">> {
  const deal = (await ctx.db.get("opportunities", args.opportunityId))!;
  return await ctx.db.insert("followUps", {
    tenantId: deal.tenantId,
    opportunityId: args.opportunityId,
    leadId: deal.leadId,
    closerId: deal.assignedCloserId!,
    type: args.type,
    reason: args.reason,
    status: args.status,
    reminderScheduledAt: args.reminderScheduledAt,
    schedulingLinkUrl:
      args.type === "scheduling_link" ? "https://calendly.com/closer/follow-up" : undefined,
    createdAt: T0,
    createdSource: "closer",
  });
}

export type CloserPipelineSeed = Awaited<ReturnType<typeof seedCloserPipeline>>;

/**
 * The closer's deals: one at each open position, three Follow-up deals with
 * different next steps, a win, a person's loss and the two missed meetings'
 * losses. Two of them were created before the period; the other closer has
 * one loss. Each has its meetings in MEETING_RANGE, the calendar's week.
 */
export async function seedCloserPipeline(harness: CloserPipelineHarness) {
  const { tenantId, closerId, otherCloserId } = harness;
  return await harness.t.run(async (ctx) => {
    const deal = (
      status: OpportunityStatus,
      createdAt: number,
      extra: { source?: DealSource; fields?: DealFields } = {},
    ) => insertCloserDeal(ctx, { tenantId, closerId, status, createdAt, ...extra });

    const deals = {
      booked: await deal("scheduled", T0 + 1 * HOUR),
      sideDeal: await deal("scheduled", T0 + 2 * HOUR, { source: "side_deal" }),
      linkSent: await deal("reschedule_link_sent", T0 + 3 * HOUR),
      reminder: await deal("follow_up_scheduled", T0 + 4 * HOUR),
      bareFollowUp: await deal("follow_up_scheduled", T0 - 2 * DAY),
      won: await deal("payment_received", T0 + 5 * HOUR),
      lostByCloser: await deal("lost", T0 + 6 * HOUR, {
        fields: { lostReason: "Budget", lostByUserId: closerId, lostAt: T0 + 6 * HOUR },
      }),
      noShow: await deal("no_show", T0 + 7 * HOUR, {
        fields: { lostReason: "no_show", lostAt: T0 + 2 * DAY },
      }),
      canceled: await deal("canceled", T0 - 3 * DAY, {
        fields: { lostReason: "canceled", lostAt: T0 + 3 * DAY },
      }),
      otherClosers: await insertCloserDeal(ctx, {
        tenantId,
        closerId: otherCloserId,
        status: "lost",
        createdAt: T0 + 1 * HOUR,
        fields: { lostReason: "Timing", lostByUserId: otherCloserId },
      }),
    };

    // The reschedule link and, beside it, a reminder the link outranks.
    await insertTask(ctx, {
      opportunityId: deals.linkSent,
      type: "scheduling_link",
      reason: "no_show_follow_up",
      status: "pending",
    });
    await insertTask(ctx, {
      opportunityId: deals.linkSent,
      type: "manual_reminder",
      reason: "closer_initiated",
      status: "pending",
      reminderScheduledAt: T0 + 4 * DAY,
    });
    // Two pending reminders, a done one before them, and a scheduling link
    // that isn't a reschedule link.
    for (const [status, days] of [
      ["pending", 5],
      ["pending", 3],
      ["completed", 1],
    ] as const) {
      await insertTask(ctx, {
        opportunityId: deals.reminder,
        type: "manual_reminder",
        reason: "closer_initiated",
        status,
        reminderScheduledAt: T0 + days * DAY,
      });
    }
    await insertTask(ctx, {
      opportunityId: deals.reminder,
      type: "scheduling_link",
      reason: "closer_initiated",
      status: "pending",
    });

    const meeting = (
      opportunityId: Id<"opportunities">,
      status: Doc<"meetings">["status"],
      scheduledAt: number,
      meetingCloserId: Id<"users"> = closerId,
    ) =>
      insertCloserMeeting(ctx, {
        tenantId,
        opportunityId,
        closerId: meetingCloserId,
        status,
        scheduledAt,
      });
    const meetings = {
      // A Calendly reschedule: the old slot canceled, the new one booked.
      bookedOld: await meeting(deals.booked, "canceled", T0 + 1 * DAY),
      booked: await meeting(deals.booked, "scheduled", T0 + 1 * DAY + HOUR),
      linkSent: await meeting(deals.linkSent, "no_show", T0 + 1 * DAY + 2 * HOUR),
      won: await meeting(deals.won, "completed", T0 + 2 * DAY),
      lostByCloser: await meeting(deals.lostByCloser, "completed", T0 + 2 * DAY + HOUR),
      noShow: await meeting(deals.noShow, "no_show", T0 + 2 * DAY + 2 * HOUR),
      canceled: await meeting(deals.canceled, "canceled", T0 + 3 * DAY),
      // Outside the week.
      reminder: await meeting(deals.reminder, "completed", T0 - DAY),
      // The other closer's.
      otherClosers: await meeting(deals.otherClosers, "completed", T0 + 2 * DAY, otherCloserId),
    };
    return { deals, meetings };
  });
}

/** The harness with the closer's pipeline seeded. */
export async function seededCloserPipeline() {
  const harness = await closerPipelineHarness();
  const seed = await seedCloserPipeline(harness);
  return { harness, seed };
}
