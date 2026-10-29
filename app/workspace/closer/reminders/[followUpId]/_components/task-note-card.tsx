import { Card } from "@/components/ui/card";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { formatShortDate } from "@/app/workspace/closer/_components/today-time";
import type { TaskDetail, TaskDetailMode } from "./task-detail-types";

type Meeting = TaskDetail["dealMeetings"][number];

const AFTER_CALL: Partial<Record<Meeting["status"], string>> = {
  held: "after the held call",
  no_show: "after the no-show",
  canceled: "after the cancellation",
};

/** The deal's last call on or before the task was set, the one it follows. */
export function callBeforeTask(detail: TaskDetail): Meeting | null {
  return (
    detail.dealMeetings.find((meeting) => meeting.scheduledAt <= detail.followUp.createdAt) ??
    null
  );
}

/**
 * Where the task came from: who set it, when, and after which call, such as
 * "Your note · set Oct 27 after the held call".
 */
export function taskOrigin(
  detail: TaskDetail,
  mode: TaskDetailMode,
  setting: BusinessDaySetting,
  closerName: string | null,
): string {
  const { followUp } = detail;
  const day = formatShortDate(followUp.createdAt, setting.timeZone);
  const previous = callBeforeTask(detail);
  const after = previous ? AFTER_CALL[previous.status] : undefined;
  const when = after ? `${day} ${after}` : day;

  if (followUp.reason === "stale_opportunity_nudge") {
    return `Automatic nudge · set ${day}, when the deal went quiet`;
  }
  if (followUp.createdSource === "admin" || followUp.reason === "admin_initiated") {
    return `Set by an admin · ${when}`;
  }
  if (followUp.createdSource === "system") {
    return `Set automatically · ${when}`;
  }
  const closer = mode === "closer" ? null : (closerName ?? "the closer");
  if (!followUp.reminderNote?.trim()) {
    return `Set by ${closer ?? "you"} · ${when}`;
  }
  return `${closer ? `${closer}’s`.replace(/^the/, "The") : "Your"} note · set ${when}`;
}

/** The headline when the task has no note: why it exists, without a pronoun. */
function reasonLine(detail: TaskDetail, firstName: string, setting: BusinessDaySetting): string {
  const previous = callBeforeTask(detail);
  const callDay = previous ? formatShortDate(previous.scheduledAt, setting.timeZone) : null;
  // A closed task is described, not handed out as an instruction.
  if (detail.followUp.status !== "pending") {
    const kind = detail.followUp.contactMethod === "text" ? "text-back" : "call-back";
    switch (detail.followUp.reason) {
      case "no_show_follow_up":
        return callDay
          ? `A ${kind} task after ${firstName} didn’t show up to the ${callDay} call. No note was left.`
          : `A ${kind} task after a no-show. No note was left.`;
      case "cancellation_follow_up":
        return callDay
          ? `A ${kind} task after ${firstName} canceled the ${callDay} call. No note was left.`
          : `A ${kind} task after a cancellation. No note was left.`;
      case "stale_opportunity_nudge":
        return "A nudge to decide the deal’s next step.";
      default:
        return `A ${kind} task for ${firstName}. No note was left.`;
    }
  }
  switch (detail.followUp.reason) {
    case "no_show_follow_up":
      return callDay
        ? `${firstName} didn’t show up to the ${callDay} call. Reach out to rebook.`
        : `${firstName} didn’t show up. Reach out to rebook.`;
    case "cancellation_follow_up":
      return callDay
        ? `${firstName} canceled the ${callDay} call. Reach out to rebook.`
        : `${firstName} canceled the call. Reach out to rebook.`;
    case "stale_opportunity_nudge":
      return "This deal has gone quiet. Decide its next step from the deal.";
    default:
      return detail.followUp.contactMethod === "text"
        ? `Text ${firstName} back. No note was left on this task.`
        : `Call ${firstName} back. No note was left on this task.`;
  }
}

/**
 * Why this task exists: the note quoted, or the reason when there's no note,
 * and a line saying where it came from.
 */
export function TaskNoteCard({
  detail,
  mode,
  setting,
  firstName,
  closerName,
}: {
  detail: TaskDetail;
  mode: TaskDetailMode;
  setting: BusinessDaySetting;
  firstName: string;
  closerName: string | null;
}) {
  const note = detail.followUp.reminderNote?.trim();
  return (
    <Card className="gap-1.5 px-4 py-3.5" aria-label="Why this task">
      {note ? (
        <blockquote className="text-[1.0625rem] leading-relaxed font-medium text-pretty whitespace-pre-wrap">
          &ldquo;{note}&rdquo;
        </blockquote>
      ) : (
        <p className="text-[1.0625rem] leading-relaxed font-medium text-pretty">
          {reasonLine(detail, firstName, setting)}
        </p>
      )}
      <p className="text-[0.8125rem] text-muted-foreground">
        {taskOrigin(detail, mode, setting, closerName)}
      </p>
    </Card>
  );
}
