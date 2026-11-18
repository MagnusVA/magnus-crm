import type { PaymentCommandCode } from "@/convex/payments/commandResult";

// One plain sentence per payment command refusal (convex/payments/commandResult.ts).
// Confirm, take out and restore all show these; restore has its own words
// for the codes it means differently.

export const PAYMENT_COMMAND_SENTENCES: Record<PaymentCommandCode, string> = {
  stale_preview: "Something changed. Check the new preview.",
  kind_off: "Recording from Whop is switched off.",
  needs_review: "This can't be undone in one step. Use the reviewed correction instead.",
  disposition_required: "Choose what the deal becomes.",
  disposition_not_allowed: "Another payment still counts on this deal, so the deal stays won. There is nothing to choose.",
  reallocated: "This Whop payment already counts for another CRM payment.",
  closed_by_other_exclusion: "A later change owns this deal now.",
  adverse: "Whop reports a refund or dispute on this payment, or one is waiting to be checked.",
  capacity_hold: "This deal already has 40 or more payment records, or this person has 100 or more deals.",
  amount_mismatch: "Whop's amount can't be read as a CRM amount.",
  no_closer: "The deal has no closer to credit. Assign one first.",
  credit_conflict: "Another closer already has credit on this deal.",
  task_closer_conflict: "An open task on this deal belongs to a different closer.",
  unlinked_manual_payment: "This deal has a payment a person recorded. Link the two from this page if they are the same money.",
  side_deal: "This is a side deal or its call already happened. Record it from the deal page.",
  qualified_only: "This deal has not booked a call yet.",
  lost_by_person: "A person closed this deal as lost. It stays closed.",
  not_paid: "Whop has not marked this payment paid.",
  binding_invalid: "The Whop mapping for this payment no longer fits this deal.",
  program_required: "Choose the program and the payment type.",
  not_owner: "This is still the closer's to confirm.",
  attendance_not_owed: "No attendance is owed on this call.",
  meeting_not_started: "The call has not started yet.",
  enrollment_status_changed: "The enrollment this payment held has changed since it was taken out.",
};

/** Restore's reasons, in the words the restore panel uses. */
const RESTORE_SENTENCES: Partial<Record<PaymentCommandCode, string>> = {
  reallocated: "The Whop payment now counts for another payment, so it can't count here too.",
  adverse: "A refund or dispute is open on this payment.",
  closed_by_other_exclusion: "A later change owns the deal. Put that one right first.",
  enrollment_status_changed: "The enrollment changed since the payment was taken out.",
  stale_preview: "The deal moved since the payment was taken out, so putting it back would undo later work.",
};

export function paymentCommandSentence(code: PaymentCommandCode) {
  return PAYMENT_COMMAND_SENTENCES[code];
}

export function restoreRefusalSentence(code: PaymentCommandCode) {
  return RESTORE_SENTENCES[code] ?? PAYMENT_COMMAND_SENTENCES[code];
}
