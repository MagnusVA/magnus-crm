import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { transitionOpportunity } from "../lib/opportunityActivity";
import { canMarkLost, describeDealState, loadDealTasks } from "../opportunities/dealGuards";
import { requireTenantUser } from "../requireTenantUser";

// The task page's choices for a scheduling link the person hasn't booked
// through ("Not booking?"). A booking through the link closes the task on its
// own (pipeline/inviteeCreated.ts marks it booked and moves the deal to
// Booked); these are for when that isn't going to happen.

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The signed-in closer's own pending scheduling link, with its deal. */
async function loadOwnedPendingLink(
  ctx: MutationCtx,
  { followUpId, tenantId, userId }: {
    followUpId: Id<"followUps">;
    tenantId: Id<"tenants">;
    userId: Id<"users">;
  },
): Promise<{
  followUp: Doc<"followUps">;
  opportunity: Doc<"opportunities">;
}> {
  const followUp = await ctx.db.get("followUps", followUpId);
  if (!followUp || followUp.tenantId !== tenantId) {
    throw new Error("Task not found");
  }
  if (followUp.closerId !== userId) {
    throw new Error("Not your task");
  }
  if (followUp.type !== "scheduling_link") {
    throw new Error("Only a scheduling link can be closed this way");
  }
  if (followUp.status !== "pending") {
    throw new Error("This link was already booked or closed");
  }

  const opportunity = await ctx.db.get("opportunities", followUp.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }
  return { followUp, opportunity };
}

/**
 * Cancel the link: the task closes and the deal stays where it is (at
 * Follow-up, since generating the link moved it there). The link is
 * expired, with the same `followUp.expired` event a booking writes when it
 * retires a link it didn't come through. The URL itself stays bookable in
 * Calendly; a booking through it later lands as any booking does.
 */
export const cancelLinkTask = mutation({
  args: { followUpId: v.id("followUps") },
  returns: v.null(),
  handler: async (ctx, { followUpId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    const { followUp, opportunity } = await loadOwnedPendingLink(ctx, {
      followUpId,
      tenantId,
      userId,
    });

    const now = Date.now();
    await ctx.db.patch("followUps", followUpId, { status: "expired" });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.expired",
      source: "closer",
      actorUserId: userId,
      fromStatus: "pending",
      toStatus: "expired",
      metadata: {
        type: followUp.type,
        reason: followUp.reason,
        opportunityId: opportunity._id,
        origin: "link_task_canceled",
      },
      occurredAt: now,
    });
    return null;
  },
});

/**
 * Mark the deal lost from a link task: the link closes (completed, outcome
 * `lost`, the reason as its note) and the deal closes as lost by the closer.
 *
 * The link closes first, so a reschedule link (which on its own keeps the
 * deal from being marked lost: it closes only through a booking) no longer
 * holds the deal; `canMarkLost` then decides as it does for any deal at
 * Follow-up. A refusal throws and nothing is written.
 *
 * The task's event names its outcome under `linkOutcome`, not `outcome`, so
 * the reminder outcome counts (reporting/activityEventCounts.ts) stay
 * reminders only.
 */
export const markLinkTaskLost = mutation({
  args: {
    followUpId: v.id("followUps"),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { followUpId, reason }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    const { followUp, opportunity } = await loadOwnedPendingLink(ctx, {
      followUpId,
      tenantId,
      userId,
    });

    const now = Date.now();
    const trimmedReason = normalizeOptionalString(reason);

    await ctx.db.patch("followUps", followUpId, {
      status: "completed",
      completedAt: now,
      completionOutcome: "lost",
      ...(trimmedReason ? { completionNote: trimmedReason } : {}),
    });

    if (!canMarkLost(opportunity, await loadDealTasks(ctx, opportunity._id))) {
      throw new Error(`Cannot mark lost: the deal is "${describeDealState(opportunity)}"`);
    }

    // Follow-up (or a Booked deal holding a link from before links moved the
    // deal) -> Closed lost, by a person.
    await transitionOpportunity(ctx, opportunity._id, {
      to: { stage: "closed", outcome: "lost" },
      fields: {
        updatedAt: now,
        lostAt: now,
        lostByUserId: userId,
        ...(trimmedReason ? { lostReason: trimmedReason } : {}),
      },
      source: "closer",
      actorUserId: userId,
      reason: trimmedReason,
      metadata: {
        followUpId,
        origin: "scheduling_link",
      },
      occurredAt: now,
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.completed",
      source: "closer",
      actorUserId: userId,
      fromStatus: "pending",
      toStatus: "completed",
      metadata: {
        linkOutcome: "lost",
        type: followUp.type,
        reason: followUp.reason,
        origin: "link_task",
      },
      occurredAt: now,
    });
    return null;
  },
});
