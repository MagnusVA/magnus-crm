import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  assertCoreRole,
  provenanceMetadata,
  toCheckResult,
  WEB,
  type CheckResult,
  type CoreActor,
  type Provenance,
} from "../lib/outcomeCores";
import { dealStageOf } from "../opportunities/stages";
import { describeDealState } from "../opportunities/dealGuards";
import { requireTenantUser } from "../requireTenantUser";

export type AdminCancelTaskArgs = { followUpId: Id<"followUps"> };

/** Every check `adminCancelTask` makes, in its order, with no write. */
async function checkAdminCancelTask(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  { followUpId }: AdminCancelTaskArgs,
) {
  assertCoreRole(actor, ["tenant_master", "tenant_admin"]);
  const { tenantId } = actor;
  const followUp = await ctx.db.get("followUps", followUpId);
  if (!followUp || followUp.tenantId !== tenantId) {
    throw new Error("Task not found");
  }
  if (followUp.status !== "pending") {
    throw new Error("This task is already closed");
  }
  const opportunity = await ctx.db.get("opportunities", followUp.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Deal not found");
  }
  if (dealStageOf(opportunity).outcome !== "open") {
    throw new Error(
      `Only a task on an open deal can be canceled; the deal is "${describeDealState(opportunity)}"`,
    );
  }
  return { followUp, opportunity };
}

/** Whether `adminCancelTaskCore` would cancel this task, without writing. */
export async function checkAdminCancelTaskAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: AdminCancelTaskArgs,
): Promise<
  CheckResult<{
    followUpId: Id<"followUps">;
    opportunityId: Id<"opportunities">;
    type: Doc<"followUps">["type"];
  }>
> {
  return await toCheckResult(async () => {
    const { followUp, opportunity } = await checkAdminCancelTask(ctx, actor, args);
    return { followUpId: followUp._id, opportunityId: opportunity._id, type: followUp.type };
  });
}

/**
 * Expires a deal's open task and leaves the deal where it is: the core of
 * `adminCancelTask`. `provenance` tags the `followUp.expired` event.
 */
export async function adminCancelTaskCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: AdminCancelTaskArgs,
  provenance: Provenance,
): Promise<null> {
  const { tenantId, userId } = actor;
  const { followUp, opportunity } = await checkAdminCancelTask(ctx, actor, args);

  const now = Date.now();
  await ctx.db.patch("followUps", followUp._id, { status: "expired" });
  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "followUp",
    entityId: followUp._id,
    eventType: "followUp.expired",
    source: "admin",
    actorUserId: userId,
    fromStatus: "pending",
    toStatus: "expired",
    metadata: {
      type: followUp.type,
      reason: followUp.reason,
      opportunityId: opportunity._id,
      origin: "admin_task_canceled",
      ...provenanceMetadata(provenance),
    },
    occurredAt: now,
  });
  return null;
}

/**
 * An admin cancels a deal's open task (a call-back, text-back or scheduling
 * link) from the person page. The task expires and the deal stays where it
 * is, open and without that step, so someone sets the next one. A link
 * expired here no longer moves the deal when booked through
 * (pipeline/bookingTargets.ts treats it as closed).
 */
export const adminCancelTask = mutation({
  args: { followUpId: v.id("followUps") },
  returns: v.null(),
  handler: async (ctx, { followUpId }) => {
    const actor = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    return await adminCancelTaskCore(ctx, actor, { followUpId }, WEB);
  },
});
