import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { adminCreateManualReminderCore } from "../admin/meetingActions";
import { createCallbackTask } from "../closer/followUpMutations";
import { emitDomainEvent } from "../lib/domainEvents";
import { withdrawAutomatedHeld } from "../lib/meetingAttendanceUndo";
import { WEB, type CoreActor } from "../lib/outcomeCores";
import { hasPermission, PERMISSIONS } from "../lib/permissions";
import { insertManualReminder } from "../lib/reminderInsert";
import { requireTenantUser } from "../requireTenantUser";
import { noteHumanResult } from "./humanResult";

type Code = "not_ready" | "not_yours" | "needs_review" | "time_past";
type Result<T extends object = object> =
  | ({ ok: true; alreadyApplied: boolean } & T)
  | { ok: false; code: Code };

type AppliedTask = {
  ok: true;
  decision: Doc<"resultAutomationDecisions">;
  deal: Doc<"opportunities">;
  task: Doc<"followUps">;
  meeting: Doc<"meetings">;
};

const refusal = v.object({
  ok: v.literal(false),
  code: v.union(v.literal("not_ready"), v.literal("not_yours"), v.literal("needs_review"), v.literal("time_past")),
});

async function readAppliedTask(
  ctx: MutationCtx,
  actor: CoreActor,
  decisionId: Id<"resultAutomationDecisions">,
): Promise<AppliedTask | { ok: false; code: Code }> {
  const decision = await ctx.db.get("resultAutomationDecisions", decisionId);
  if (!decision || decision.tenantId !== actor.tenantId) return { ok: false, code: "not_ready" };
  if (!decision.opportunityId || !decision.writtenFollowUpId || !decision.meetingId ||
      !decision.callBefore || decision.state !== "applied" ||
      (decision.kind !== "call_back" && decision.kind !== "payment_owed") ||
      !decision.proposal || !("type" in decision.proposal) || decision.proposal.type !== "task") {
    return { ok: false, code: "not_ready" };
  }
  const [deal, task, meeting] = await Promise.all([
    ctx.db.get("opportunities", decision.opportunityId),
    ctx.db.get("followUps", decision.writtenFollowUpId),
    ctx.db.get("meetings", decision.meetingId),
  ]);
  if (!deal || deal.tenantId !== actor.tenantId) return { ok: false, code: "not_ready" };
  if (actor.role === "closer" && deal.assignedCloserId !== actor.userId) {
    return { ok: false, code: "not_yours" };
  }
  if (!task || task.tenantId !== actor.tenantId || task.opportunityId !== deal._id ||
      task.automationDecisionId !== decisionId || task.status !== "pending" ||
      task.reminderScheduledAt !== decision.proposal.reminderScheduledAt ||
      task.contactMethod !== decision.proposal.contactMethod || task.completedAt !== undefined ||
      task.closerId !== deal.assignedCloserId ||
      deal.stage !== "follow_up" || deal.outcome !== "open" ||
      decision.humanResultRevisionAfter !== (deal.humanResultRevision ?? 0) ||
      !meeting || meeting.tenantId !== actor.tenantId || meeting.opportunityId !== deal._id ||
      meeting.status !== "held" || meeting.attendanceSource !== "call_insights" ||
      meeting.attendanceDecisionId !== decisionId || decision.callBefore.meetingId !== meeting._id) {
    return { ok: false, code: "needs_review" };
  }
  const pending = await ctx.db.query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", deal._id).eq("status", "pending"))
    .take(21);
  if (pending.length > 20 ||
      pending.some((other) => other._id !== task._id && other.reason !== "stale_opportunity_nudge")) {
    return { ok: false, code: "needs_review" };
  }
  return { ok: true, decision, deal, task, meeting };
}

async function expireCallTask(
  ctx: MutationCtx,
  actor: CoreActor,
  applied: AppliedTask,
  code: "next_step_changed" | "automation_undone",
  now: number,
) {
  await ctx.db.patch("followUps", applied.task._id, { status: "expired" });
  await emitDomainEvent(ctx, {
    tenantId: actor.tenantId,
    entityType: "followUp",
    entityId: applied.task._id,
    eventType: "followUp.expired",
    source: actor.role === "closer" ? "closer" : "admin",
    actorUserId: actor.userId,
    fromStatus: "pending",
    toStatus: "expired",
    metadata: { code, decisionId: applied.decision._id },
    occurredAt: now,
  });
}

export const changeNextStep = mutation({
  args: {
    decisionId: v.id("resultAutomationDecisions"),
    contactMethod: v.union(v.literal("call"), v.literal("text")),
    reminderScheduledAt: v.number(),
  },
  returns: v.union(refusal, v.object({
    ok: v.literal(true), alreadyApplied: v.boolean(), followUpId: v.id("followUps"),
  })),
  handler: async (ctx, { decisionId, contactMethod, reminderScheduledAt }):
    Promise<Result<{ followUpId: Id<"followUps"> }>> => {
    const actor = await requireTenantUser(ctx, ["closer", ...PERMISSIONS["result-automation:lower"]]);
    const applied = await readAppliedTask(ctx, actor, decisionId);
    if (!applied.ok) return applied;
    const now = Date.now();
    if (!Number.isFinite(reminderScheduledAt)) return { ok: false, code: "time_past" };

    await expireCallTask(ctx, actor, applied, "next_step_changed", now);
    await ctx.db.patch("resultAutomationDecisions", decisionId, { state: "corrected", auditOpenDueAt: undefined });
    const { deal, task } = applied;
    if (reminderScheduledAt <= now) {
      const followUpId = await insertManualReminder(ctx, {
        opportunity: deal,
        closerId: task.closerId,
        source: actor.role === "closer" ? "closer" : "admin",
        actorUserId: actor.userId,
        contactMethod,
        reminderScheduledAt,
        reason: actor.role === "closer" ? "closer_initiated" : "admin_initiated",
        now,
      });
      await noteHumanResult(ctx, deal._id, actor);
      return { ok: true, alreadyApplied: false, followUpId };
    }

    const args = { opportunityId: deal._id, contactMethod, reminderScheduledAt };
    // Each human reminder core records the revision for its own write.
    const { followUpId } = actor.role === "closer"
      ? await createCallbackTask(ctx, actor, args, WEB)
      : await adminCreateManualReminderCore(ctx, actor, args, WEB);
    return { ok: true, alreadyApplied: false, followUpId };
  },
});

async function undoTask(
  ctx: MutationCtx,
  actor: CoreActor,
  decisionId: Id<"resultAutomationDecisions">,
  callHappened: boolean,
  automaticOnly: boolean,
): Promise<Result> {
  if (!hasPermission(actor.role, "result-automation:lower") && !(callHappened && actor.role === "closer")) {
    return { ok: false, code: "not_yours" };
  }
  const applied = await readAppliedTask(ctx, actor, decisionId);
  if (!applied.ok) return applied;
  if (automaticOnly && applied.decision.appliedVia !== "automatic") {
    return { ok: false, code: "not_ready" };
  }

  if (!callHappened) {
    const meetings = await ctx.db.query("meetings")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", applied.deal._id))
      .take(51);
    const resolvedAt = applied.decision.resolvedAt;
    if (resolvedAt === undefined || meetings.length > 50 || meetings.some((meeting) =>
      meeting._id !== applied.meeting._id && meeting.status !== "scheduled" && (
        meeting.scheduledAt > applied.meeting.scheduledAt ||
        Math.max(meeting.heldMarkedAt ?? 0, meeting.noShowMarkedAt ?? 0, meeting.canceledAt ?? 0) > resolvedAt
      ))) return { ok: false, code: "needs_review" };
  }

  const now = Date.now();
  await expireCallTask(ctx, actor, applied, "automation_undone", now);
  if (!callHappened) {
    await withdrawAutomatedHeld(ctx, { meetingId: applied.meeting._id, decisionId, actorUserId: actor.userId, now });
  }
  await ctx.db.patch("resultAutomationDecisions", decisionId, { state: "undone", auditOpenDueAt: undefined });
  await noteHumanResult(ctx, applied.deal._id, actor);
  return { ok: true, alreadyApplied: false };
}

export const callDidNotHappen = mutation({
  args: { decisionId: v.id("resultAutomationDecisions") },
  returns: v.union(refusal, v.object({ ok: v.literal(true), alreadyApplied: v.boolean() })),
  handler: async (ctx, { decisionId }): Promise<Result> => {
    const actor = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:lower"]]);
    return await undoTask(ctx, actor, decisionId, false, false);
  },
});

export async function undoCallTaskCore(
  ctx: MutationCtx,
  actor: CoreActor,
  decisionId: Id<"resultAutomationDecisions">,
  args: { callHappened: boolean },
): Promise<Result> {
  return await undoTask(ctx, actor, decisionId, args.callHappened, true);
}
