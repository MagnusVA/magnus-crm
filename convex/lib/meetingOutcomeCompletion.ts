import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { replaceMeetingAggregate } from "../reporting/writeHooks";
import { updateOpportunityMeetingRefs } from "./opportunityMeetingRefs";
import { validateMeetingTransition } from "./statusTransitions";

type TerminalMeetingStatus = "completed" | "no_show" | "canceled";
type MeetingPatch = Partial<
  Omit<Doc<"meetings">, "_id" | "_creationTime" | "status" | "completedAt">
>;

const FORBIDDEN_TIMING_PATCH_KEYS = new Set([
  "startedAt",
  "startedAtSource",
  "stoppedAt",
  "stoppedAtSource",
  "lateStartDurationMs",
  "exceededScheduledDurationMs",
  "overranDurationMs",
  "attendanceCheckId",
  "overranDetectedAt",
  "reviewId",
  "noShowWaitDurationMs",
  "status",
  "completedAt",
]);

function assertTimingFreePatch(patch: MeetingPatch | undefined): void {
  if (!patch) {
    return;
  }

  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_TIMING_PATCH_KEYS.has(key)) {
      throw new Error(`Meeting outcome patch cannot include "${key}"`);
    }
  }
}

export async function completeMeetingForOutcome(
  ctx: MutationCtx,
  args: {
    meeting: Doc<"meetings">;
    opportunity: Doc<"opportunities">;
    toMeetingStatus: TerminalMeetingStatus;
    completedAt: number;
    extraMeetingPatch?: MeetingPatch;
  },
): Promise<Doc<"meetings">> {
  const { meeting, opportunity, toMeetingStatus, completedAt } = args;

  if (meeting.opportunityId !== opportunity._id) {
    throw new Error("Meeting does not belong to opportunity");
  }
  if (meeting.tenantId !== opportunity.tenantId) {
    throw new Error("Meeting tenant does not match opportunity tenant");
  }
  if (!validateMeetingTransition(meeting.status, toMeetingStatus)) {
    throw new Error(
      `Cannot transition meeting from "${meeting.status}" to "${toMeetingStatus}"`,
    );
  }

  assertTimingFreePatch(args.extraMeetingPatch);

  await ctx.db.patch(meeting._id, {
    status: toMeetingStatus,
    completedAt,
    ...args.extraMeetingPatch,
  });

  const nextMeeting = await replaceMeetingAggregate(ctx, meeting, meeting._id);
  await updateOpportunityMeetingRefs(ctx, opportunity._id);
  return nextMeeting;
}
