import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { adminMarkLostCore, checkAdminMarkLostAllowed } from "../admin/meetingActions";
import { checkMeetingLossAllowed, recordMeetingLoss } from "../closer/meetingActions";
import { maskReservedLossReason } from "../lib/lossReasonLabel";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";
import { transitionOpportunity } from "../lib/opportunityActivity";
import { WEB, type CoreActor } from "../lib/outcomeCores";
import { hasPermission } from "../lib/permissions";
import { addPinnedLine } from "../lib/pinnedLines";
import { insertManualReminder } from "../lib/reminderInsert";
import { loadDealOpenTasks } from "../opportunities/dealGuards";
import { RESERVED_LOSS_REASONS } from "../opportunities/stages";
import { automationCommandRefusalValidator, refuseAutomation, type AutomationCommandResult } from "../payments/commandResult";
import { requireTenantUser } from "../requireTenantUser";
import { CALL_ASK_ROLES, callCommandSuccess, confirmCallArgs, finishCallConfirm, matchesAppliedRefusal, prepareCallConfirm } from "./confirmCall";
import { noteHumanResult } from "./humanResult";
import { refusalProposalOf } from "./proposals";

export const confirmRefusal = mutation({
  args: confirmCallArgs,
  returns: v.union(automationCommandRefusalValidator, v.object({
    ...callCommandSuccess, decisionId: v.id("resultAutomationDecisions"),
  })),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...CALL_ASK_ROLES]);
    const result = await prepareCallConfirm(ctx, actor, args, "refusal");
    if (!result.ok) return result;
    const { decision, deal, meetingId } = result;
    const decisionId = decision._id;
    if (result.alreadyApplied) return { ok: true as const, alreadyApplied: true, decisionId };
    if (refusalProposalOf(decision)?.meetingId !== meetingId) return refuseAutomation("not_ready");

    const coreArgs = { opportunityId: deal._id, meetingId };
    const closer = actor.role === "closer";
    const check = closer ? checkMeetingLossAllowed : checkAdminMarkLostAllowed;
    if (!(await check(ctx, actor, coreArgs)).ok) return refuseAutomation("deal_not_open");
    const core = closer ? recordMeetingLoss : adminMarkLostCore;
    await core(ctx, actor, coreArgs, WEB, { decisionId, refusal: true });
    const lostAt = (await ctx.db.get("opportunities", deal._id))?.lostAt;
    if (lostAt === undefined) throw new Error("Call refusal is missing its loss time");
    // The activity feeds return the event reason verbatim. Keep the reserved
    // reason on the deal for the stage machine and the label on its event.
    const events = await ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", actor.tenantId).eq("entityType", "opportunity").eq("entityId", deal._id)
          .gte("occurredAt", lostAt))
      .take(20);
    const event = events.find((row) =>
      row.eventType === "opportunity.marked_lost" && row.reason === RESERVED_LOSS_REASONS.call_refusal &&
      row.actorUserId === actor.userId && row.metadata?.includes(`"decisionId":${JSON.stringify(decisionId)}`));
    if (!event) throw new Error("Call refusal is missing its loss event");
    await ctx.db.patch("domainEvents", event._id, { reason: maskReservedLossReason(event.reason) ?? undefined });
    await finishCallConfirm(ctx, actor, { ...result, now: lostAt });
    return { ok: true as const, alreadyApplied: false, decisionId };
  },
});

export async function reopenRefusalCore(
  ctx: MutationCtx, actor: CoreActor, decisionId: Id<"resultAutomationDecisions">,
): Promise<AutomationCommandResult> {
  const decision = await ctx.db.get("resultAutomationDecisions", decisionId);
  if (!decision?.opportunityId || !decision.meetingId ||
      decision.tenantId !== actor.tenantId || decision.kind !== "refusal_loss" ||
      (decision.appliedVia !== "meeting_confirm" && decision.appliedVia !== "automatic")) {
    return refuseAutomation("not_ready");
  }
  const deal = await ctx.db.get("opportunities", decision.opportunityId);
  if (!deal || deal.tenantId !== actor.tenantId) return refuseAutomation("not_ready");
  const closerId = deal.assignedCloserId;
  if (!hasPermission(actor.role, "result-automation:lower") &&
      !(actor.role === "closer" && closerId === actor.userId)) return refuseAutomation("not_yours");
  if (decision.state === "undone") return { ok: true, alreadyApplied: true };
  if (decision.state !== "applied") return refuseAutomation("not_ready");
  if (!closerId || !matchesAppliedRefusal(decision, deal) ||
      decision.humanResultRevisionAfter !== (deal.humanResultRevision ?? 0)) return refuseAutomation("needs_review");

  const meeting = await ctx.db.get("meetings", decision.meetingId);
  if (!meeting || meeting.tenantId !== actor.tenantId || meeting.opportunityId !== deal._id ||
      meeting.status !== "held" || meeting.attendanceSource !== "call_insights" ||
      meeting.attendanceDecisionId !== decisionId || decision.callBefore?.meetingId !== meeting._id) {
    return refuseAutomation("needs_review");
  }
  if ((await loadDealOpenTasks(ctx, deal._id)).hasOpenTask) return refuseAutomation("open_task");

  const now = Date.now();
  const source = actor.role === "closer" ? "closer" : "admin";
  const actorUserId = actor.userId;
  const reopened = await transitionOpportunity(ctx, deal._id, {
    to: { stage: "follow_up" },
    exception: "call_refusal_reopened",
    source, actorUserId, occurredAt: now,
    fields: { updatedAt: now },
    metadata: { decisionId },
  });
  const followUpId = await insertManualReminder(ctx, {
    opportunity: reopened, closerId, source, actorUserId,
    contactMethod: "call", reminderScheduledAt: now,
    reason: "call_insights", task: { purpose: "call_back" }, automationDecisionId: decisionId,
    now,
  });

  // The held mark stands. Its automation link is only valid while the receipt is applied.
  await patchMeetingLifecycle(ctx, meeting._id, { attendanceSource: undefined, attendanceDecisionId: undefined });
  await ctx.db.patch("resultAutomationDecisions", decisionId, {
    state: "undone", replacementFollowUpId: followUpId,
  });
  await addPinnedLine(ctx, {
    tenantId: deal.tenantId, userId: closerId, kind: "refusal_reopened",
    opportunityId: deal._id, meetingId: meeting._id, followUpId, decisionId,
    dealPositionAfter: "follow_up", createdAt: now,
  });
  await noteHumanResult(ctx, deal._id, actor);
  return { ok: true, alreadyApplied: false };
}

export const reopenRefusal = mutation({
  args: { decisionId: v.id("resultAutomationDecisions") },
  returns: v.union(automationCommandRefusalValidator, v.object(callCommandSuccess)),
  handler: async (ctx, { decisionId }) => {
    const actor = await requireTenantUser(ctx, [...CALL_ASK_ROLES]);
    return await reopenRefusalCore(ctx, actor, decisionId);
  },
});
