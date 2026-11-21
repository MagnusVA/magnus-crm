import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { callEvidenceWanted } from "../callInsights/settings";
import { scheduleCallEvaluation } from "./callDecisions";
import { scheduleEvaluationsForLead } from "./decisions";
import { isPaymentKind } from "./proposals";

// A human result stands down every outstanding automatic proposal on its deal
// (build contract §2.7). Each human result path calls `noteHumanResult` once,
// in its own transaction, after its writes. The revision fences every older
// decision at once; stopping them is bookkeeping, and an approval re-checks the
// revision anyway, so past the first batch a scheduled continuation finishes.

/** Decisions a human result stops: the ones still waiting on someone. */
export const OUTSTANDING_DECISION_STATES = ["ready", "needs_person", "blocked"] as const;
const HUMAN_RESULT_STATES = [...OUTSTANDING_DECISION_STATES, "notice"] as const;
export const HUMAN_RESULT_STOP_BATCH = 50;
/** A human result asks for the person's unresolved Whop payments to be re-evaluated (B1). */
export const RE_EVALUATE_AFTER_HUMAN_RESULT = true;

type Actor = { tenantId: Id<"tenants">; userId: Id<"users"> };

/**
 * Stop the deal's outstanding decisions derived before `revision`, up to one
 * batch. Older decisions come first in each state's range (they were inserted
 * before the bump), so the first newer one ends that state. Returns whether a
 * full batch was stopped and more may remain.
 */
async function stopOutstandingDecisions(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    revision: number;
    consumeDecisionId?: Id<"resultAutomationDecisions">;
    actorUserId?: Id<"users">;
    now: number;
    cause?: "assignment";
  },
): Promise<boolean> {
  let budget = HUMAN_RESULT_STOP_BATCH;
  const tenant = args.cause === "assignment" ? await ctx.db.get("tenants", args.tenantId) : null;
  const scheduled = new Set<Id<"meetings">>();
  for (const state of HUMAN_RESULT_STATES) {
    if (budget === 0) return true;
    const limit = budget;
    const rows: Doc<"resultAutomationDecisions">[] = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_opportunityId_and_state", (q) =>
        q.eq("tenantId", args.tenantId).eq("opportunityId", args.opportunityId).eq("state", state))
      .take(limit + 1);
    let reachedNewer = false;
    for (const row of rows.slice(0, limit)) {
      budget -= 1;
      if (row._id === args.consumeDecisionId) continue;
      if (row.humanResultRevision >= args.revision) {
        reachedNewer = true;
        break;
      }
      const reassignedCall = args.cause === "assignment" && !isPaymentKind(row.kind);
      await ctx.db.patch("resultAutomationDecisions", row._id, {
        state: "stopped",
        stopCode: reassignedCall ? "closer_changed" : "human_result",
        resolvedAt: args.now,
        resolvedByUserId: args.actorUserId,
      });
      if (reassignedCall && row.meetingId && callEvidenceWanted(tenant) && !scheduled.has(row.meetingId)) {
        scheduled.add(row.meetingId);
        await scheduleCallEvaluation(ctx, tenant, row.meetingId, "assignment");
      }
    }
    if (!reachedNewer && rows.length > limit) return true;
  }
  return false;
}

/**
 * Every human result path calls this once, in its own transaction, after its writes.
 * Raw-patches opportunities.humanResultRevision (+1) only: never updatedAt or latestActivityAt.
 * Stops this deal's ready / needs_person / blocked / notice decisions (stopCode "human_result"), except consumeDecisionId.
 * take(50); overflow schedules internal.automation.humanResult.stopRemaining (approval re-checks the revision anyway).
 * Records the new revision on the consumed decision when it is an applied receipt, for one-tap undo.
 */
export async function noteHumanResult(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  actor: Actor,
  options: { consumeDecisionId?: Id<"resultAutomationDecisions">; cause?: "assignment" } = {},
): Promise<{ revision: number }> {
  const deal = await ctx.db.get("opportunities", opportunityId);
  if (!deal || deal.tenantId !== actor.tenantId) throw new Error(`Deal ${opportunityId} not found in this tenant`);
  const revision = (deal.humanResultRevision ?? 0) + 1;
  // No aggregate key, search or projection row reads this field: it is in neither
  // field list in lib/opportunityActivity.ts, and no reporting write hook or projection
  // reads it. A raw patch keeps updatedAt and latestActivityAt, which writeOpportunity would move.
  await ctx.db.patch("opportunities", opportunityId, { humanResultRevision: revision });

  const now = Date.now();
  const { consumeDecisionId, cause } = options;
  if (consumeDecisionId) {
    const consumed = await ctx.db.get("resultAutomationDecisions", consumeDecisionId);
    if (consumed?.tenantId !== actor.tenantId || consumed.opportunityId !== opportunityId) {
      throw new Error(`Decision ${consumeDecisionId} is not on deal ${opportunityId}`);
    }
    if (consumed.state === "applied") {
      await ctx.db.patch("resultAutomationDecisions", consumeDecisionId, { humanResultRevisionAfter: revision });
    }
  }

  const more = await stopOutstandingDecisions(ctx, {
    tenantId: actor.tenantId, opportunityId, revision, consumeDecisionId, actorUserId: actor.userId, now, cause,
  });
  if (more) {
    await ctx.scheduler.runAfter(0, internal.automation.humanResult.stopRemaining, {
      tenantId: actor.tenantId, opportunityId, revision, consumeDecisionId, actorUserId: actor.userId, cause,
    });
  }

  if (RE_EVALUATE_AFTER_HUMAN_RESULT) {
    await scheduleEvaluationsForLead(ctx, actor.tenantId, deal.leadId, "human_result", { opportunityId, previousRevision: revision - 1, actorUserId: actor.userId, consumeDecisionId });
  }
  return { revision };
}

/** Finishes stopping decisions derived before `revision`, one batch per run. */
export const stopRemaining = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    revision: v.number(),
    consumeDecisionId: v.optional(v.id("resultAutomationDecisions")),
    actorUserId: v.optional(v.id("users")),
    cause: v.optional(v.literal("assignment")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const more = await stopOutstandingDecisions(ctx, { ...args, now: Date.now() });
    if (more) await ctx.scheduler.runAfter(0, internal.automation.humanResult.stopRemaining, args);
    return null;
  },
});
