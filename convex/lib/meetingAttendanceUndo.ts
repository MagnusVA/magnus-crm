import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { emitDomainEvent } from "./domainEvents";
import { correctLeadLifecycle } from "./leadLifecycle";
import { patchMeetingLifecycle } from "./meetingLifecycle";
import { transitionOpportunity } from "./opportunityActivity";
import { validateAutomationHeldUndone } from "./statusTransitions";

/** Withdraw the held mark written by this call decision, through the meeting exception. */
export async function withdrawAutomatedHeld(
  ctx: MutationCtx,
  args: {
    meetingId: Id<"meetings">;
    decisionId: Id<"resultAutomationDecisions">;
    actorUserId?: Id<"users">;
    now: number;
  },
): Promise<void> {
  const { meetingId, decisionId, actorUserId, now } = args;
  const [decision, meeting] = await Promise.all([
    ctx.db.get("resultAutomationDecisions", decisionId),
    ctx.db.get("meetings", meetingId),
  ]);
  if (!decision?.callBefore || decision.state !== "applied" || !meeting ||
      decision.meetingId !== meetingId || decision.callBefore.meetingId !== meetingId ||
      decision.tenantId !== meeting.tenantId || decision.opportunityId !== meeting.opportunityId ||
      (decision.kind !== "call_back" && decision.kind !== "payment_owed")) {
    throw new Error("Call decision does not own this meeting");
  }
  const deal = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!deal || deal.tenantId !== meeting.tenantId ||
      !validateAutomationHeldUndone({
        meeting,
        decisionId,
        humanResultRevision: deal.humanResultRevision ?? 0,
        humanResultRevisionAfter: decision.humanResultRevisionAfter,
      })) {
    throw new Error("Call attendance is no longer safe to withdraw");
  }

  const source = actorUserId ? "admin" : "system";
  await patchMeetingLifecycle(ctx, meetingId, {
    status: "scheduled",
    heldMarkedAt: undefined,
    attendanceSource: undefined,
    attendanceDecisionId: undefined,
  });
  await correctLeadLifecycle(ctx, deal.leadId, "attendance_withdrawn", actorUserId);

  if (decision.callBefore.position === "booked" && deal.stage === "follow_up" && deal.outcome === "open" &&
      deal.latestMeetingId === meetingId &&
      decision.resolvedAt !== undefined && deal.updatedAt <= decision.resolvedAt) {
    await transitionOpportunity(ctx, deal._id, {
      to: { stage: "booked" },
      fields: { latestActivityAt: decision.callBefore.latestActivityAt },
      source,
      actorUserId,
      occurredAt: now,
      metadata: { decisionId },
    });
  }
  await emitDomainEvent(ctx, {
    tenantId: deal.tenantId,
    entityType: "meeting",
    entityId: meetingId,
    eventType: "meeting.attendance_withdrawn",
    source,
    actorUserId,
    fromStatus: "held",
    toStatus: "scheduled",
    metadata: { decisionId, exception: "automation_held_undone" },
    occurredAt: now,
  });
}
