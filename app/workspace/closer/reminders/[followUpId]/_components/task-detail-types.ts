import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

/**
 * What `getReminderDetail` returns for a task the closer can open. The admin
 * twin's `getAdminReminderDetail` returns the same fields and the task's
 * closer, so both pages render one view.
 */
export type TaskDetail = NonNullable<
  FunctionReturnType<typeof api.closer.reminderDetail.getReminderDetail>
>;

/**
 * Which side is rendering: the closer's page, with the queue and every
 * outcome, or the admin twin at `/workspace/pipeline/reminders/[followUpId]`,
 * which can only log a payment for the task's closer.
 */
export type TaskDetailMode = "closer" | "admin";

/** "Call back", "Text back", or "Deal gone quiet": what the task asks for. */
export function taskKindLabel(followUp: TaskDetail["followUp"]): string {
  if (followUp.reason === "stale_opportunity_nudge") return "Deal gone quiet";
  return followUp.contactMethod === "text" ? "Text back" : "Call back";
}
