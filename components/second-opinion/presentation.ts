import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { CallRecord } from "@/convex/secondOpinion/questions";
export type OpinionDetail = NonNullable<
  FunctionReturnType<typeof api.secondOpinion.forMeeting>
>;
export const labels: Record<string, string> = {
  held: "Held",
  no_show: "No-show",
  not_sales_call: "Not a sales call",
  paid: "Paid",
  call_back: "Call-back",
  lost: "Lost",
  undecided: "Undecided",
  partner: "Partner's buy-in",
  price: "Price",
  timing: "Timing",
  fit: "Program fit",
  trust: "Trust",
  none: "None",
  agrees: "Agrees",
  unsure: "Not sure",
  disagrees: "Disagrees",
  hint: "Hint",
  checked: "Checked",
  queued: "Checking",
  skipped: "Skipped",
  failed: "Failed",
};

/** Why a check didn't answer, in the words an admin reads. */
export const failureLabels: Record<string, string> = {
  thin_transcript: "The prospect barely speaks in the transcript, so the result can't be checked.",
  other_prospect: "The recording's invitee isn't this prospect, so it's probably someone else's call.",
  no_transcript: "The transcript is missing or expired.",
  cap_reached: "The month's cap was reached.",
  disabled: "The second opinion was off when it ran.",
  upstream_error: "The AI Gateway didn't answer.",
  rejected: "The AI Gateway refused the request.",
  format_changed: "The AI Gateway's answer changed shape.",
};

/** What Jev heard, or why it hasn't answered. */
export function heardLabel(opinion: OpinionDetail["opinion"]) {
  if (opinion.answers)
    return `${labels[opinion.answers.attendance.choice]} · ${labels[opinion.answers.ending.choice]}`;
  return labels[opinion.status] ?? opinion.status;
}
export function recordLabel(record: CallRecord | undefined) {
  if (!record) return "Not recorded";
  if (record.kind === "payment")
    return record.amountMinor !== undefined && record.currency
      ? `${new Intl.NumberFormat("en-US", { style: "currency", currency: record.currency }).format(record.amountMinor / 100)} · ${record.paymentType ?? "Payment"}`
      : "Payment";
  return `${labels[record.kind]}${record.lossReason ? ` · ${record.lossReason}` : ""}`;
}
export function localTime(at: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}
export function localDate(at: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}
