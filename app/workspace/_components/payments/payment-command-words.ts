import { getErrorCode, getErrorMessage } from "@/lib/errors";
import type { PaymentCommandCode } from "@/convex/payments/commandResult";

// What a payment command's refusal means, in one plain sentence each
// (convex/payments/commandResult.ts). Commands return `{ ok: false, code }`;
// the payment dialogs' saves throw the same codes as `payment.<code>`.

export const PAYMENT_COMMAND_WORDS: Record<PaymentCommandCode, string> = {
  stale_preview: "This payment or deal changed since the page loaded. Check the updated details and try again.",
  kind_off: "Confirming Whop payments is turned off right now. Record the payment from the payment form instead.",
  needs_review: "This can no longer be undone in one tap. Billing can correct it from the payment.",
  disposition_required: "Choose what happens to the deal before you save.",
  disposition_not_allowed: "That choice isn't available for this deal.",
  reallocated: "This Whop payment now counts for another record, so nothing was changed.",
  closed_by_other_exclusion: "Another change already took this payment out, so nothing was changed.",
  adverse: "Whop reports a refund or dispute on this payment. Billing must review it first.",
  capacity_hold: "This deal or person has too many payments to add another here. Billing will record it.",
  amount_mismatch: "The amount or currency differs from the Whop payment. Record it as Whop reports it.",
  no_closer: "The deal has no closer to credit, so the payment can't be recorded yet.",
  credit_conflict: "The payment's credit doesn't match the deal's closer. Billing will sort it out.",
  task_closer_conflict: "The open task on this deal belongs to another closer.",
  unlinked_manual_payment: "The deal has a payment typed by hand that may be the same money. Billing will compare them.",
  side_deal: "Whop payments can't be confirmed on a side deal.",
  qualified_only: "The deal hasn't been booked yet, so the payment can't win it.",
  lost_by_person: "Someone closed this deal as lost. Billing decides whether the payment reopens it.",
  not_paid: "Whop doesn't report this payment as paid.",
  binding_invalid: "The Whop product mapping for this payment changed. Billing will check it.",
  program_required: "Pick the program this payment is for.",
  not_owner: "This isn't yours to confirm right now.",
  attendance_not_owed: "This call's attendance is already recorded or no longer needed.",
  meeting_not_started: "The call hasn't started yet. Record its attendance once it has.",
  enrollment_status_changed: "The person's program changed since the page loaded. Check it and try again.",
  sandbox_payment: "Sandbox payments can only be recorded on the development deployment.",
};

const OTHER_PAYMENT_ERRORS: Record<string, string> = {
  whop_payment_found:
    "Whop reports more than one payment for this person. Use Won · log payment to pick the right one.",
};

/** The sentence for a command's refusal code. */
export function paymentCommandSentence(code: PaymentCommandCode): string {
  return PAYMENT_COMMAND_WORDS[code];
}

/** The refusal code a save threw as `payment.<code>`, if it is one. */
export function thrownPaymentCode(error: unknown): string | null {
  const code = getErrorCode(error);
  return code?.startsWith("payment.") ? code.slice("payment.".length) : null;
}

/** The sentence for a thrown save error: a known payment code, else the server's message. */
export function paymentErrorSentence(error: unknown, fallback: string): string {
  const code = thrownPaymentCode(error);
  if (code && code in PAYMENT_COMMAND_WORDS) return PAYMENT_COMMAND_WORDS[code as PaymentCommandCode];
  if (code && code in OTHER_PAYMENT_ERRORS) return OTHER_PAYMENT_ERRORS[code];
  return getErrorMessage(error, fallback);
}
