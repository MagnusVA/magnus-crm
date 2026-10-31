import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { nextStepFromTasks, pickOpenTask } from "../closer/pipelineDeals";
import { dealStageOf } from "../opportunities/stages";

// Far above the open tasks one deal has.
const OPEN_TASK_SCAN = 20;

/**
 * An open deal's next step on the person page, in My Pipeline's order: the
 * next call, else the open task (`taskId` opens it). `canSet` says whether
 * the viewer may set a step here: on their deal (any deal with a closer, for
 * an admin) whose call was held or which is at Follow-up, with no open task.
 * A Booked deal's step is its call, and a call that passed with no result is
 * recorded on the meeting page first. Closed deals have none.
 */
export async function loadDealNextStepFor(
  ctx: QueryCtx,
  opportunity: Doc<"opportunities">,
  canAct: boolean,
) {
  const { stage, outcome } = dealStageOf(opportunity);
  if (outcome !== "open") return null;
  const pending = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", opportunity._id).eq("status", "pending"),
    )
    .take(OPEN_TASK_SCAN);
  const openTask = pickOpenTask(pending);
  return {
    callAt: opportunity.nextMeetingAt ?? null,
    task: nextStepFromTasks(pending),
    taskId: openTask?._id ?? null,
    canSet:
      canAct &&
      openTask === null &&
      opportunity.assignedCloserId !== undefined &&
      (stage === "call_held" || stage === "follow_up"),
  };
}
