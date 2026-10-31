import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  canRestartFollowUp,
  canStartFollowUp,
  describeDealState,
  loadDealOpenTasks,
} from "../opportunities/dealGuards";
import { patchOpportunityLifecycle, transitionOpportunity } from "./opportunityActivity";

/**
 * How a new follow-up (a scheduling link or a call-back) lands on its deal:
 * `move` takes the deal to Follow-up (from Booked, Call held or a missed
 * meeting's loss); `stay` adds the task to a deal already at Follow-up whose
 * tasks all closed, from the deal itself rather than a call.
 */
export type FollowUpStart = "move" | "stay";

/** Where a new follow-up may start, or throws `${refusal}: the deal is "…"`. */
export async function resolveFollowUpStart(
  ctx: MutationCtx,
  opportunity: Doc<"opportunities">,
  meeting: Doc<"meetings"> | null,
  refusal: string,
): Promise<FollowUpStart> {
  if (canStartFollowUp(opportunity)) return "move";
  // A call's outcome only moves a deal waiting for it, never one at Follow-up.
  if (!meeting && canRestartFollowUp(opportunity, await loadDealOpenTasks(ctx, opportunity._id))) {
    return "stay";
  }
  throw new Error(`${refusal}: the deal is "${describeDealState(opportunity)}"`);
}

/** Moves the deal to Follow-up, or touches it when it is there already. */
export async function landFollowUp(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  start: FollowUpStart,
  args: { source: "closer" | "admin"; actorUserId: Id<"users">; occurredAt: number },
): Promise<void> {
  if (start === "stay") {
    await patchOpportunityLifecycle(ctx, opportunityId, { updatedAt: args.occurredAt });
    return;
  }
  // Booked or Call held -> Follow-up, or a missed meeting's Closed lost ->
  // Follow-up, which only the exception allows.
  await transitionOpportunity(ctx, opportunityId, {
    to: { stage: "follow_up" },
    fields: { updatedAt: args.occurredAt },
    exception: "missed_meeting_next_step",
    source: args.source,
    actorUserId: args.actorUserId,
    occurredAt: args.occurredAt,
  });
}
