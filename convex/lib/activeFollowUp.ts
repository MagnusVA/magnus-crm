import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { awaitsCallResult, describeDealState } from "../opportunities/dealGuards";
import { emitDomainEvent } from "./domainEvents";

export type ActiveFollowUpSummary = {
  _id: Id<"followUps">;
  type: Doc<"followUps">["type"];
  status: "pending";
  createdAt: number;
  reminderScheduledAt?: number;
  schedulingLinkUrl?: string;
};

/**
 * Latest `pending` follow-up for an opportunity, sorted by `createdAt` desc.
 *
 * Returns the full document so mutations can inspect every field. Query
 * sites that only need a summary should project via `toActiveFollowUpSummary`.
 */
export async function loadActiveFollowUpDoc(
  ctx: QueryCtx | MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"followUps"> | null> {
  const followUps = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", opportunityId).eq("status", "pending"),
    )
    .take(50);

  return followUps.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/**
 * Project a follow-up doc to the lightweight summary shape that UI needs.
 *
 * The summary exposes only what the closer meeting detail page renders,
 * avoiding leaking tenant-internal fields into the client payload.
 */
export function toActiveFollowUpSummary(
  followUp: Doc<"followUps"> | null,
): ActiveFollowUpSummary | null {
  if (!followUp) return null;
  return {
    _id: followUp._id,
    type: followUp.type,
    status: "pending",
    createdAt: followUp.createdAt,
    reminderScheduledAt: followUp.reminderScheduledAt,
    schedulingLinkUrl: followUp.schedulingLinkUrl,
  };
}

/**
 * Convenience for query sites that want the summary directly.
 */
export async function loadActiveFollowUpSummary(
  ctx: QueryCtx | MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<ActiveFollowUpSummary | null> {
  return toActiveFollowUpSummary(await loadActiveFollowUpDoc(ctx, opportunityId));
}

/**
 * Expire a follow-up that was started but never finished: a scheduling link
 * generated while the deal still waits for its call's result. The pending
 * follow-up hides the meeting's outcome buttons, so expiring it brings them
 * back. The deal and the meeting stay as they are, and the event is the same
 * `followUp.expired` a booking writes when it retires a reschedule link.
 */
export async function expireUnfinishedFollowUp(
  ctx: MutationCtx,
  args: {
    followUp: Doc<"followUps">;
    opportunity: Doc<"opportunities">;
    source: "closer" | "admin";
    actorUserId: Id<"users">;
  },
): Promise<void> {
  const { followUp, opportunity } = args;
  if (followUp.opportunityId !== opportunity._id) {
    throw new Error("Follow-up does not belong to this opportunity");
  }
  if (followUp.status !== "pending") {
    throw new Error("Follow-up is not pending");
  }
  if (!awaitsCallResult(opportunity)) {
    throw new Error(
      `Only a follow-up on a deal still waiting for its call's result can be canceled; the deal is "${describeDealState(opportunity)}"`,
    );
  }

  const now = Date.now();
  await ctx.db.patch("followUps", followUp._id, { status: "expired" });
  await emitDomainEvent(ctx, {
    tenantId: followUp.tenantId,
    entityType: "followUp",
    entityId: followUp._id,
    eventType: "followUp.expired",
    source: args.source,
    actorUserId: args.actorUserId,
    fromStatus: "pending",
    toStatus: "expired",
    metadata: {
      type: followUp.type,
      reason: followUp.reason,
      opportunityId: opportunity._id,
    },
    occurredAt: now,
  });
}
