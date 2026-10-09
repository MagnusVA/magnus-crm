import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { patchMeetingLifecycle } from "./meetingLifecycle";
import { validateMeetingTransition } from "./statusTransitions";

type TerminalMeetingStatus = "completed" | "no_show" | "canceled";
type MeetingPatch = Partial<
  Omit<
    Doc<"meetings">,
    | "_id"
    | "_creationTime"
    | "tenantId"
    | "opportunityId"
    | "status"
    | "completedAt"
  >
>;

const RESERVED_MEETING_OUTCOME_PATCH_KEYS = new Set([
  "_id",
  "_creationTime",
  "tenantId",
  "opportunityId",
  "status",
  "completedAt",
]);

function assertTimingFreePatch(patch: MeetingPatch | undefined): void {
  if (!patch) {
    return;
  }

  for (const key of Object.keys(patch)) {
    if (RESERVED_MEETING_OUTCOME_PATCH_KEYS.has(key)) {
      throw new Error(`Meeting outcome patch cannot include "${key}"`);
    }
  }
}

export async function completeMeetingForOutcome(
  ctx: MutationCtx,
  args: {
    meetingId: Id<"meetings">;
    opportunityId: Id<"opportunities">;
    toMeetingStatus: TerminalMeetingStatus;
    completedAt: number;
    extraMeetingPatch?: MeetingPatch;
  },
): Promise<Doc<"meetings">> {
  const { toMeetingStatus, completedAt } = args;
  const meeting = await ctx.db.get("meetings", args.meetingId);
  const opportunity = await ctx.db.get("opportunities", args.opportunityId);
  if (!meeting || !opportunity)
    throw new Error("Meeting or opportunity not found");

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

  return await patchMeetingLifecycle(ctx, meeting._id, {
    status: toMeetingStatus,
    completedAt,
    ...args.extraMeetingPatch,
  });
}
