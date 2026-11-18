import { Card } from "@/components/ui/card";
import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { formatAmountMinor } from "@/lib/format-currency";
import {
  formatBusinessDate,
  formatShortDate,
} from "@/app/workspace/closer/_components/today-time";
import {
  declineWords,
  isSetFromCall,
  taskPurposeLabel,
  type TaskDetail,
  type TaskDetailMode,
} from "./task-detail-types";

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
  if (isSetFromCall(followUp)) {
    const call = previous ? `the ${formatShortDate(previous.scheduledAt, setting.timeZone)} call` : "the call";
    if (followUp.createdSource === "system") return `Set automatically from ${call} · ${day}`;
    const by =
      followUp.createdSource === "admin"
        ? "an admin"
        : mode === "closer"
          ? "you"
          : (closerName ?? "the closer");
    return `Set from ${call} · confirmed by ${by} ${day}`;
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
    if (isSetFromCall(detail.followUp)) {
      return detail.followUp.purpose === "payment_owed"
        ? `A task to check on ${firstName}’s payment, set from the call.`
        : `A ${kind} task for ${firstName}, set from the call.`;
    }
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
  if (isSetFromCall(detail.followUp)) {
    const reach = detail.followUp.contactMethod === "text" ? "Text" : "Call";
    return detail.followUp.purpose === "payment_owed"
      ? `${firstName} said they would pay. ${reach} to check the payment came through.`
      : `${reach} ${firstName} back, as agreed on the call.`;
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
  const purpose = taskPurposeLabel(detail.followUp);
  const fromCall = isSetFromCall(detail.followUp);
  const promise = promiseLine(detail.followUp, setting);
  const declineCode = detail.followUp.declineCode;
  return (
    <Card className="gap-1.5 px-4 py-3.5" aria-label="Why this task">
      {purpose ? (
        <p className="flex flex-wrap items-center gap-x-1.5 text-[0.8125rem] text-muted-foreground">
          <span className={PURPOSE_CHIP}>{purpose}</span>
          {fromCall ? <span>set from the call</span> : null}
        </p>
      ) : null}
      {note ? (
        <blockquote className="text-[1.0625rem] leading-relaxed font-medium text-pretty whitespace-pre-wrap">
          &ldquo;{note}&rdquo;
        </blockquote>
      ) : (
        <p className="text-[1.0625rem] leading-relaxed font-medium text-pretty">
          {reasonLine(detail, firstName, setting)}
        </p>
      )}
      {promise ? <p className="font-medium tabular-nums">{promise}</p> : null}
      {declineCode ? (
        <p className="text-[0.9375rem]">
          Last payment attempt: <span className="font-medium">{declineWords(declineCode)}</span>
        </p>
      ) : null}
      <p className="text-[0.8125rem] text-muted-foreground">
        {taskOrigin(detail, mode, setting, closerName)}
      </p>
    </Card>
  );
}

const PURPOSE_CHIP =
  "shrink-0 rounded-[4px] bg-secondary px-1.5 font-condensed text-[11px] leading-[18px] font-bold tracking-[0.1em] text-secondary-foreground uppercase";

/**
 * A payment-owed task's promise: "Promised $500.00 by Fri, Nov 20", or the
 * part of it the call gave. Null for any other task.
 */
function promiseLine(followUp: TaskDetail["followUp"], setting: BusinessDaySetting): string | null {
  if (followUp.purpose !== "payment_owed") return null;
  const amount =
    followUp.expectedAmountMinor !== undefined && followUp.expectedCurrency
      ? formatAmountMinor(followUp.expectedAmountMinor, followUp.expectedCurrency)
      : null;
  const by =
    followUp.promisedPaymentAt !== undefined
      ? formatBusinessDate(businessDateForInstant(followUp.promisedPaymentAt, setting), {
          weekday: "short",
          month: "short",
          day: "numeric",
        })
      : null;
  if (amount && by) return `Promised ${amount} by ${by}`;
  if (amount) return `Promised ${amount}`;
  if (by) return `Promised by ${by}`;
  return null;
}
