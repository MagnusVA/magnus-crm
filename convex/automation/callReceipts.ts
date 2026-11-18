import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

type Decision = Doc<"resultAutomationDecisions">;

/**
 * Record the task or refusal that was applied on this meeting. A confirmed
 * write calls noteHumanResult with consumeDecisionId after recording the receipt.
 */
export async function recordCallReceipt(
  ctx: MutationCtx,
  args: {
    decisionId: Id<"resultAutomationDecisions">;
    appliedVia: "meeting_confirm" | "automatic";
    approverUserId?: Id<"users">;
    followUpId?: Id<"followUps">;
    callBefore: NonNullable<Decision["callBefore"]>;
    now: number;
  },
): Promise<Id<"resultAutomationDecisions">> {
  const { decisionId, appliedVia, approverUserId, followUpId, callBefore, now } = args;
  const decision = await ctx.db.get("resultAutomationDecisions", decisionId);
  if (!decision?.opportunityId || !decision.meetingId || decision.meetingId !== callBefore.meetingId) {
    throw new Error("Call decision does not name this meeting");
  }
  const isTask = decision.kind === "call_back" || decision.kind === "payment_owed";
  if ((!isTask && decision.kind !== "refusal_loss") || isTask !== Boolean(followUpId) ||
      (callBefore.followUpId && callBefore.followUpId !== followUpId)) {
    throw new Error("Call receipt does not match the decision kind");
  }
  if (decision.state === "applied" && decision.appliedVia === appliedVia &&
      decision.writtenFollowUpId === followUpId && decision.resolvedByUserId === approverUserId) {
    return decisionId;
  }
  if (decision.state !== "ready" && !(decision.kind === "refusal_loss" && decision.state === "notice")) {
    throw new Error("Call decision is no longer ready to apply");
  }

  const [deal, meeting, task] = await Promise.all([
    ctx.db.get("opportunities", decision.opportunityId),
    ctx.db.get("meetings", decision.meetingId),
    followUpId ? ctx.db.get("followUps", followUpId) : null,
  ]);
  if (!deal || deal.tenantId !== decision.tenantId ||
      !meeting || meeting.tenantId !== decision.tenantId || meeting.opportunityId !== deal._id ||
      meeting.status !== "held" || meeting.attendanceDecisionId !== decisionId ||
      meeting.attendanceSource !== "call_insights") {
    throw new Error("Call decision did not write this held mark");
  }
  if (isTask && (!task || task.tenantId !== decision.tenantId || task.opportunityId !== deal._id ||
      task.sourceMeetingId !== meeting._id || task.automationDecisionId !== decisionId ||
      task.status !== "pending" || task.purpose !== decision.kind)) {
    throw new Error("Call decision did not write this task");
  }
  if (!isTask && (deal.lostReason !== "call_refusal" || deal.outcome !== "lost" ||
      deal.lostAt !== now || deal.lostByUserId !== approverUserId)) {
    throw new Error("Call decision did not write this refusal");
  }
  if (appliedVia === "automatic" ? approverUserId || decision.mode !== "automatic" : !approverUserId) {
    throw new Error("Call decision does not match the receipt's actor");
  }

  await ctx.db.patch("resultAutomationDecisions", decisionId, {
    state: "applied",
    appliedVia,
    resolvedByUserId: approverUserId,
    resolvedAt: now,
    writtenFollowUpId: followUpId,
    callBefore: { ...callBefore, followUpId },
    humanResultRevisionAfter: appliedVia === "automatic" ? deal.humanResultRevision ?? 0 : undefined,
  });
  return decisionId;
}
