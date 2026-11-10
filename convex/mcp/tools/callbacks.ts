import { v } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { emitDomainEvent } from "../../lib/domainEvents";
import { rejectRequest } from "../../lib/observability/errors";
import { mcpCallerValidator, requireMcpUser, type Provenance } from "../guard";
import { formatLocal, parseLocalDateTime } from "../time";

/**
 * Moving a pending call-back (decision 20): the one narrow edit the agent may
 * make. It changes the time on a call-back the closer owns and keeps its
 * history in a `followUp.rescheduled` event, which is neither a touch nor a
 * last touch. Nothing else about the task, the deal or the meeting changes.
 */
export async function moveCallbackCore(
  ctx: MutationCtx,
  actor: { tenantId: Id<"tenants">; userId: Id<"users"> },
  args: { followUpId: Id<"followUps">; reminderScheduledAt: number },
  provenance: Provenance,
) {
  const task = await ctx.db.get("followUps", args.followUpId);
  if (!task || task.tenantId !== actor.tenantId || task.closerId !== actor.userId) {
    throw rejectRequest("callback.not_yours", "That isn't one of your call-backs.");
  }
  if (task.type !== "manual_reminder" || task.status !== "pending") {
    throw rejectRequest(
      "callback.not_pending",
      "Only a pending call-back or text-back can move. This task is done or isn't a call-back.",
    );
  }
  const now = Date.now();
  if (args.reminderScheduledAt <= now) {
    throw rejectRequest("callback.in_past", "Pick a time in the future.");
  }
  const from = task.reminderScheduledAt;
  if (from === args.reminderScheduledAt) return { task, from, moved: false };
  await ctx.db.patch("followUps", task._id, { reminderScheduledAt: args.reminderScheduledAt });
  await emitDomainEvent(ctx, {
    tenantId: actor.tenantId,
    entityType: "followUp",
    entityId: task._id,
    eventType: "followUp.rescheduled",
    source: "closer",
    actorUserId: actor.userId,
    metadata: {
      opportunityId: task.opportunityId,
      fromScheduledAt: from ?? null,
      toScheduledAt: args.reminderScheduledAt,
      ...(provenance.via === "mcp" ? { via: "mcp", agentClient: provenance.agentClient } : { via: "web" }),
    },
    occurredAt: now,
  });
  return { task, from, moved: true };
}

/** `magnus_move_callback`. */
export const moveCallback = internalMutation({
  args: {
    caller: mcpCallerValidator,
    taskId: v.id("followUps"),
    date: v.string(),
    time: v.string(),
  },
  returns: v.object({
    taskId: v.id("followUps"),
    from: v.union(v.string(), v.null()),
    due: v.string(),
    moved: v.boolean(),
  }),
  handler: async (ctx, { caller, taskId, date, time }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    const at = parseLocalDateTime(date, time, me.timeZone);
    const result = await moveCallbackCore(
      ctx,
      me,
      { followUpId: taskId, reminderScheduledAt: at },
      { via: "mcp", agentClient: me.agentClient },
    );
    return {
      taskId,
      from: result.from ? formatLocal(result.from, me.timeZone) : null,
      due: formatLocal(at, me.timeZone),
      moved: result.moved,
    };
  },
});
