import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { slotEndAt } from "../callInsights/suggest/state";
import { checkCallbackTaskAllowed, createCallbackTask } from "../closer/followUpMutations";
import { computeLatestActivityAt } from "../lib/opportunityActivity";
import { WEB, type CoreActor } from "../lib/outcomeCores";
import { addPinnedLine } from "../lib/pinnedLines";
import { dealPosition } from "../opportunities/stages";
import {
  automationCommandRefusalValidator, refuseAutomation, type AutomationCommandResult,
} from "../payments/commandResult";
import { scheduleAudit } from "./audit";
import { dropToAsk } from "./automaticPayments";
import { assertAutomaticAllowed } from "./breaker";
import { rederiveCall, scheduleCallEvaluation } from "./callDecisions";
import { recordCallReceipt } from "./callReceipts";
import { stopDecision } from "./decisions";
import { taskProposalOf } from "./proposals";

// The automatic call-task executor (phase 3 contract §2.13): a call-back or
// payment-owed task a certified rule read from a recorded call, set with no
// person. It goes through the same closer core a confirmed ask uses, with
// the core's `system` option: the task is the assigned closer's, the call is
// marked held by this decision, the deal's last activity is kept, and no
// Second opinion is queued. The scheduled wake-up is not authority.

type Decision = Doc<"resultAutomationDecisions">;
type TaskKind = "call_back" | "payment_owed";

export const callTaskResultValidator = v.union(
  automationCommandRefusalValidator,
  v.object({ ok: v.literal(true), alreadyApplied: v.boolean(), followUpId: v.id("followUps") }),
);

async function supersede(ctx: MutationCtx, decision: Decision, tenant: Doc<"tenants"> | null) {
  await stopDecision(ctx, decision._id, null, "input_changed");
  if (decision.meetingId) await scheduleCallEvaluation(ctx, tenant, decision.meetingId, "sweep");
  return refuseAutomation("stale_preview");
}

/**
 * One automatic task write, in the caller's mutation. In order:
 *  1. the decision is ready, automatic, a task kind, due, on a deal and meeting;
 *  2. assertAutomaticAllowed: kind automatic, certificate current, no breaker,
 *     same policy and activation (a refusal drops the decision to an ask);
 *  3. rederiveCall gives the stored inputKey (else superseded);
 *  4. the deal's humanResultRevision is the decision's, the deal is Booked or
 *     Follow-up, the meeting is scheduled and its slot is over;
 *  5. the proposal is this kind's, for this meeting and the assigned closer,
 *     with a time still ahead, and the closer core's own checks pass;
 * then the core writes the task and the held mark, the receipt records the
 * before-fields, the closer gets a pinned line, and the audit is scheduled.
 */
export async function applyCallTask(
  ctx: MutationCtx, decisionId: Id<"resultAutomationDecisions">, now: number,
): Promise<AutomationCommandResult<{ followUpId: Id<"followUps"> }>> {
  const decision = await ctx.db.get("resultAutomationDecisions", decisionId);
  if (decision?.state === "applied" && decision.appliedVia === "automatic" && decision.writtenFollowUpId) {
    return { ok: true, alreadyApplied: true, followUpId: decision.writtenFollowUpId };
  }
  if (!decision || decision.state !== "ready" || decision.mode !== "automatic" ||
      (decision.kind !== "call_back" && decision.kind !== "payment_owed") ||
      decision.dueAt === undefined || now < decision.dueAt || !decision.opportunityId || !decision.meetingId) {
    return refuseAutomation("not_ready");
  }
  const kind: TaskKind = decision.kind;
  const tenant = await ctx.db.get("tenants", decision.tenantId);

  const allowed = await assertAutomaticAllowed(ctx, { tenantId: decision.tenantId, kind, decision }, now);
  if (!allowed.ok) {
    await dropToAsk(ctx, tenant, decision, null);
    return refuseAutomation(allowed.code);
  }

  if (!(await rederiveCall(ctx, decision, now)).same) return await supersede(ctx, decision, tenant);
  const [deal, meeting] = await Promise.all([
    ctx.db.get("opportunities", decision.opportunityId),
    ctx.db.get("meetings", decision.meetingId),
  ]);
  const position = deal && dealPosition(deal.stage, deal.outcome);
  if (!deal || deal.tenantId !== decision.tenantId || (deal.humanResultRevision ?? 0) !== decision.humanResultRevision ||
      (position !== "booked" && position !== "follow_up") ||
      !meeting || meeting.tenantId !== decision.tenantId || meeting.opportunityId !== deal._id ||
      meeting.status !== "scheduled" || now < slotEndAt(meeting)) {
    return await supersede(ctx, decision, tenant);
  }
  const proposal = taskProposalOf(decision);
  const closerId = deal.assignedCloserId;
  if (!proposal || proposal.purpose !== kind || proposal.meetingId !== meeting._id || !closerId ||
      proposal.closerId !== closerId || decision.assignedCloserId !== closerId || proposal.reminderScheduledAt <= now) {
    return await supersede(ctx, decision, tenant);
  }
  const coreArgs = {
    opportunityId: deal._id, meetingId: meeting._id,
    contactMethod: proposal.contactMethod, reminderScheduledAt: proposal.reminderScheduledAt,
  };
  const closer: CoreActor = { tenantId: deal.tenantId, userId: closerId, role: "closer" };
  if (!(await checkCallbackTaskAllowed(ctx, closer, coreArgs)).ok) return await supersede(ctx, decision, tenant);

  const callBefore = {
    position, meetingId: meeting._id, meetingStatus: "scheduled" as const,
    latestActivityAt: deal.latestActivityAt ?? computeLatestActivityAt(deal),
  };
  // The receipt names the certificate in force before the core reads the decision.
  await ctx.db.patch("resultAutomationDecisions", decisionId, { certificateSampleId: allowed.sampleId });
  const { followUpId } = await createCallbackTask(ctx, null, coreArgs, WEB, {
    decisionId,
    system: true,
    task: {
      purpose: proposal.purpose,
      expectedAmountMinor: proposal.expectedAmountMinor,
      expectedCurrency: proposal.expectedCurrency,
      promisedPaymentAt: proposal.promisedPaymentAt,
      declineCode: proposal.declineCode,
    },
  });
  await recordCallReceipt(ctx, { decisionId, appliedVia: "automatic", followUpId, callBefore, now });
  // The call left Needs outcome without the closer: a line says why.
  await addPinnedLine(ctx, {
    tenantId: deal.tenantId, userId: closerId, kind: "call_result_set",
    opportunityId: deal._id, meetingId: meeting._id, followUpId, decisionId, createdAt: now,
  });
  await scheduleAudit(ctx, { _id: decisionId }, now);
  return { ok: true, alreadyApplied: false, followUpId };
}

/** Scheduled at the decision's dueAt by evaluateCall, and by the repair sweep. */
export const executeCallTask = internalMutation({
  args: { decisionId: v.id("resultAutomationDecisions") },
  returns: callTaskResultValidator,
  handler: async (ctx, { decisionId }) => await applyCallTask(ctx, decisionId, Date.now()),
});
