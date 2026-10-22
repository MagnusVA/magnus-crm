import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { PaginationOptions } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  isMissedMeetingLoss,
  loadPendingRescheduleLink,
  type MissedMeeting,
} from "../opportunities/dealState";
import {
  dealPosition,
  dealStageOf,
  stageOfPosition,
  type DealPosition,
} from "../opportunities/stages";

// The closer's pipeline list (docs/plans/phase-5-deal-status.md §6.2): the
// closer's deals at one position, or all of them, optionally created in a
// period, newest first.

const positionFilterValidator = v.union(
  v.literal("qualified"),
  v.literal("booked"),
  v.literal("call_held"),
  v.literal("follow_up"),
  v.literal("won"),
  v.literal("lost"),
);

// Far above the pending tasks one deal has; the reminder read stops here.
const PENDING_TASK_SCAN = 20;

/** What a Follow-up deal waits on (§4.5), or null when it waits on nothing. */
export type CloserNextStep =
  | { kind: "reschedule_link_sent" }
  | { kind: "reminder"; reminderScheduledAt: number };

/**
 * The page of the closer's deals: at `position` on its stage index, or all
 * of them on the createdAt index, each with `createdAt` in [periodStart,
 * periodEnd) when a period is given.
 */
async function paginateCloserDeals(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  closerId: Id<"users">,
  filters: {
    position?: DealPosition;
    period?: { start: number; end: number };
  },
  paginationOpts: PaginationOptions,
) {
  const { position, period } = filters;

  if (position) {
    const { stage, outcome } = stageOfPosition(position);
    return await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_assignedCloserId_stage_outcome_createdAt", (q) => {
        const atPosition = q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", closerId)
          .eq("stage", stage)
          .eq("outcome", outcome);
        return period
          ? atPosition.gte("createdAt", period.start).lt("createdAt", period.end)
          : atPosition;
      })
      .order("desc")
      .paginate(paginationOpts);
  }

  return await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_assignedCloserId_and_createdAt", (q) => {
      const closers = q.eq("tenantId", tenantId).eq("assignedCloserId", closerId);
      return period
        ? closers.gte("createdAt", period.start).lt("createdAt", period.end)
        : closers;
    })
    .order("desc")
    .paginate(paginationOpts);
}

/**
 * A Follow-up deal's next step: "Reschedule link sent" when it has a pending
 * reschedule link, else its earliest pending reminder, else none. An
 * ordinary scheduling link isn't shown. Two indexed reads, each bounded.
 */
export async function loadCloserNextStep(
  ctx: QueryCtx,
  dealId: Id<"opportunities">,
): Promise<CloserNextStep | null> {
  const { link } = await loadPendingRescheduleLink(ctx, dealId);
  if (link) {
    return { kind: "reschedule_link_sent" };
  }

  const pending = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", dealId).eq("status", "pending"),
    )
    .take(PENDING_TASK_SCAN);
  let earliest: number | null = null;
  for (const task of pending) {
    if (task.type !== "manual_reminder" || task.reminderScheduledAt === undefined) {
      continue;
    }
    if (earliest === null || task.reminderScheduledAt < earliest) {
      earliest = task.reminderScheduledAt;
    }
  }
  return earliest === null ? null : { kind: "reminder", reminderScheduledAt: earliest };
}

/** One row of the closer's pipeline: the deal's position, never its status. */
async function toPipelineRow(
  ctx: QueryCtx,
  deal: Doc<"opportunities">,
  lead: Pick<Doc<"leads">, "_id" | "fullName" | "email" | "phone"> | undefined,
) {
  const { stage, outcome } = dealStageOf(deal);
  const position = dealPosition(stage, outcome);
  const missedMeeting: MissedMeeting | null = isMissedMeetingLoss(deal);
  const nextStep =
    position === "follow_up" ? await loadCloserNextStep(ctx, deal._id) : null;

  return {
    _id: deal._id,
    leadId: deal.leadId,
    leadName:
      lead?.fullName ?? lead?.email ?? (lead ? `Lead ${lead._id.slice(-6)}` : "Unknown"),
    leadEmail: lead?.email,
    leadPhone: lead?.phone,
    position,
    missedMeeting,
    nextStep,
    nextMeetingId: deal.nextMeetingId,
    nextMeetingAt: deal.nextMeetingAt,
    latestMeetingId: deal.latestMeetingId,
    latestMeetingAt: deal.latestMeetingAt,
    createdAt: deal.createdAt,
  };
}

/**
 * List the closer's deals with an optional position and created-time period.
 *
 * Each row carries the person's name and email, the deal's position, the
 * missed meeting that closed it, a Follow-up deal's next step, and the
 * meeting refs already on the deal.
 */
export const listMyOpportunities = query({
  args: {
    paginationOpts: paginationOptsValidator,
    positionFilter: v.optional(positionFilterValidator),
    periodStart: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
  },
  handler: async (ctx, { paginationOpts, positionFilter, periodStart, periodEnd }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const period =
      periodStart !== undefined && periodEnd !== undefined
        ? { start: periodStart, end: periodEnd }
        : undefined;

    const paginatedResult = await paginateCloserDeals(
      ctx,
      tenantId,
      userId,
      { position: positionFilter, period },
      paginationOpts,
    );

    // Most recently updated first within the page, as before.
    const deals = [...paginatedResult.page].sort((a, b) => b.updatedAt - a.updatedAt);

    const leadIds = [...new Set(deals.map((deal) => deal.leadId))];
    const leads = await Promise.all(leadIds.map((leadId) => ctx.db.get("leads", leadId)));
    const leadById = new Map<Id<"leads">, Doc<"leads">>();
    for (const lead of leads) {
      if (lead) {
        leadById.set(lead._id, lead);
      }
    }

    const page = await Promise.all(
      deals.map((deal) => toPipelineRow(ctx, deal, leadById.get(deal.leadId))),
    );

    return { ...paginatedResult, page };
  },
});
