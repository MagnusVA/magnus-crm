import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

/** Everything `getReminderDetail` returns for a task the closer can open. */
export type CloserTaskDetail = NonNullable<
  FunctionReturnType<typeof api.closer.reminderDetail.getReminderDetail>
>;

/**
 * The reminder pane's fields. The admin twin's `getAdminReminderDetail`
 * returns the same fields and the task's closer, so both pages render one
 * view; the link-only fields are the closer's alone.
 */
export type TaskDetail = Omit<CloserTaskDetail, "followedMeeting" | "bookedMeeting">;

/** A scheduling link the closer opened on the task page (closer only). */
export type LinkTaskDetail = CloserTaskDetail;

/**
 * Which side is rendering: the closer's page, with the queue and every
 * outcome, or the admin twin at `/workspace/pipeline/reminders/[followUpId]`,
 * which can only log a payment for the task's closer.
 */
export type TaskDetailMode = "closer" | "admin";

/**
 * "Call back", "Text back", "Deal gone quiet", or for a link "Reschedule
 * link" (after a no-show) or "Scheduling link": what the task is.
 */
export function taskKindLabel(followUp: TaskDetail["followUp"]): string {
  if (followUp.type === "scheduling_link") {
    return followUp.reason === "no_show_follow_up" ? "Reschedule link" : "Scheduling link";
  }
  if (followUp.reason === "stale_opportunity_nudge") return "Deal gone quiet";
  if (followUp.purpose === "payment_owed") return "Payment owed";
  return followUp.contactMethod === "text" ? "Text back" : "Call back";
}

/**
 * "Payment owed" or "Call back" for a task a call decision set (or one of
 * its corrections), from what the call said the task is for. Null for any
 * other task.
 */
export function taskPurposeLabel(followUp: TaskDetail["followUp"]): string | null {
  switch (followUp.purpose) {
    case "payment_owed":
      return "Payment owed";
    case "call_back":
      return "Call back";
    default:
      return null;
  }
}

/** Whether the task was set from a recorded call, asked or automatic. */
export function isSetFromCall(followUp: TaskDetail["followUp"]): boolean {
  return followUp.reason === "call_insights";
}

/**
 * A failed Whop attempt's decline code in words: a small fixed map, and
 * "the payment failed" for any other code.
 */
export function declineWords(code: string): string {
  switch (code) {
    case "insufficient_funds":
      return "insufficient funds";
    case "card_declined":
    case "generic_decline":
      return "card declined";
    default:
      return "the payment failed";
  }
}
