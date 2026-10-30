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
  return followUp.contactMethod === "text" ? "Text back" : "Call back";
}
