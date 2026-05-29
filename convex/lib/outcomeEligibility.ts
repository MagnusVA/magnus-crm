import type { Doc, Id } from "../_generated/dataModel";

const OUTCOME_LEAD_MS = 5 * 60_000;

export function isMeetingOutcomeEligible(
  meeting: Doc<"meetings">,
  now: number,
): boolean {
  return (
    meeting.status === "scheduled" &&
    now >= meeting.scheduledAt - OUTCOME_LEAD_MS
  );
}

export function assertCanRecordMeetingOutcome(args: {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  userId: Id<"users">;
  role: Doc<"users">["role"];
  now: number;
}): void {
  const isAdmin =
    args.role === "tenant_master" || args.role === "tenant_admin";

  if (args.meeting.opportunityId !== args.opportunity._id) {
    throw new Error("Meeting does not belong to this opportunity");
  }
  if (args.meeting.tenantId !== args.opportunity.tenantId) {
    throw new Error("Meeting tenant does not match opportunity tenant");
  }
  if (args.meeting.status !== "scheduled") {
    throw new Error(`Meeting is not scheduled (current: ${args.meeting.status})`);
  }
  if (args.opportunity.status !== "scheduled") {
    throw new Error(
      `Opportunity is not scheduled (current: ${args.opportunity.status})`,
    );
  }
  if (!isAdmin && args.opportunity.assignedCloserId !== args.userId) {
    throw new Error("Not your meeting");
  }
  if (!isAdmin && !isMeetingOutcomeEligible(args.meeting, args.now)) {
    throw new Error("Outcome actions open 5 minutes before the scheduled time.");
  }
}

export function assertCanRecordLegacyMeetingOutcome(args: {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  userId: Id<"users">;
  role: Doc<"users">["role"];
}): boolean {
  const isLegacyState =
    args.meeting.status === "in_progress" ||
    args.meeting.status === "meeting_overran" ||
    args.opportunity.status === "in_progress" ||
    args.opportunity.status === "meeting_overran";
  if (!isLegacyState) {
    return false;
  }

  const isAdmin =
    args.role === "tenant_master" || args.role === "tenant_admin";

  if (args.meeting.opportunityId !== args.opportunity._id) {
    throw new Error("Meeting does not belong to this opportunity");
  }
  if (args.meeting.tenantId !== args.opportunity.tenantId) {
    throw new Error("Meeting tenant does not match opportunity tenant");
  }
  if (!isAdmin && args.opportunity.assignedCloserId !== args.userId) {
    throw new Error("Not your meeting");
  }

  return true;
}
