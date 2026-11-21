import { formatDistanceStrict, formatDistanceToNowStrict } from "date-fns";
import type { Doc } from "@/convex/_generated/dataModel";
import { DEAL_POSITION_LABELS, type DealOutcome, type DealStage } from "@/convex/opportunities/stages";
import { getErrorCode, getErrorMessage } from "@/lib/errors";

// Words for Whop payments in Billing. A Whop payment is a fact Whop reports,
// never cash: these screens never add Whop amounts together.

type ProviderPayment = Doc<"providerPayments">;
export type ProviderReviewReason = NonNullable<ProviderPayment["reviewReason"]>;
export type ProviderDismissReason = NonNullable<ProviderPayment["dismissReason"]>;

export const WHOP_VIEW_HREF = "/workspace/billing?view=whop";
export const INTEGRATIONS_HREF = "/workspace/settings?tab=integrations";
export const WHOP_SETTINGS_HREF = "/workspace/settings/whop";

/** One plain sentence per reason a Whop payment waits for a person. */
export const PROVIDER_REASON_SENTENCES: Record<ProviderReviewReason, string> = {
  ready: "Matches one person with one open deal.",
  not_paid: "Whop has not reported a positive payment.",
  unknown_payer: "The payer's email matches no one.",
  no_payer_email: "Whop sent no email for the payer.",
  phone_only: "Whop sent only a phone number for the payer.",
  ambiguous_person: "The payer's email matches more than one person.",
  phone_conflict: "The payer's email and phone point to different people.",
  no_open_deal: "This person has no open deal.",
  several_open_deals: "This person has two or more open deals.",
  qualified_only: "This person's only open deal has not booked a call yet.",
  side_deal: "This person's open deal is a side deal or already had its call.",
  lost_by_person: "A person marked this deal lost.",
  system_loss: "The system closed this deal as lost.",
  won_deal_no_membership: "This deal is already won, and no Whop membership is tied to it.",
  deal_newer_than_payment: "The open deal was created after Whop collected the money.",
  historical: "Whop collected this before the account was connected.",
  dismissed: "Someone dismissed this payment.",
  stale_payment: "Whop collected this more than 7 days ago.",
  unmapped_product: "The Whop product or its price is not mapped yet.",
  multi_item: "The checkout had more than one item.",
  financing: "The buyer paid through financing.",
  renewal_unbound: "This is a renewal, and no deal is tied to its membership.",
  unbound_membership: "This charge belongs to a membership no deal is tied to.",
  unknown_billing_reason: "Whop did not say whether this is a first payment or a renewal.",
  unsupported_currency: "Whop's amount is in a currency the CRM cannot read.",
  unlinked_manual_payment: "This deal already has a payment a person recorded. Is it the same money?",
  amount_mismatch: "A payment a person recorded on this deal has a different amount.",
  no_closer: "The deal has no closer to credit.",
  credit_conflict: "Two closers have a claim on this deal.",
  capacity_hold: "This deal already has 40 or more payment records.",
  binding_conflict: "Two Whop mappings are active for the same item.",
  program_mismatch: "The Whop payment and the deal point to different programs.",
  read_limit: "There is too much history to check this payment automatically.",
  excluded_wrong_match: "The only matching deal is one this payment was already taken off.",
  connection_mismatch: "This payment belongs to a different Whop connection.",
  refund: "Whop reports a refund on this payment.",
  dispute: "Whop reports a dispute on this payment.",
  not_my_sale: "The deal's closer said this is not their sale.",
  covers_several: "One payment may cover more than one charge, or the reverse.",
};

/** Reasons a product or price mapping in Settings would settle. */
export const MAPPING_REASONS = new Set<ProviderReviewReason>(["unmapped_product"]);

/** Reasons where the payer is not known to be anyone in the CRM. */
export const UNKNOWN_PAYER_REASONS = new Set<ProviderReviewReason>([
  "unknown_payer",
  "no_payer_email",
  "phone_only",
  "ambiguous_person",
  "phone_conflict",
]);

export const UNKNOWN_PAYER_NOTE =
  "Payer shown separately from the buyer. Picking a person does not add this email to their record.";

export const NOT_CASH_NOTE = "These are Whop's records, not CRM payments. None is in a cash total.";

export function reasonSentence(reason: ProviderReviewReason | null | undefined) {
  return reason ? PROVIDER_REASON_SENTENCES[reason] : "Waiting for a person to look at it.";
}

/** The row's one button: what the reviewer does first. */
export function reasonAction(reason: ProviderReviewReason | null) {
  if (reason && UNKNOWN_PAYER_REASONS.has(reason)) return "Pick the person";
  if (reason === "unlinked_manual_payment" || reason === "amount_mismatch") return "Compare";
  return "Review";
}

export const DISMISS_REASON_LABELS: Record<ProviderDismissReason, string> = {
  not_crm_money: "Not money for a deal in this CRM",
  test_payment: "A test payment",
  duplicate_in_provider: "A duplicate in Whop",
  other: "Another reason",
};

export const PROVIDER_STATUS_LABELS: Record<ProviderPayment["status"], string> = {
  draft: "Draft, not charged",
  open: "Open, not paid yet",
  authorized: "Authorized, not collected yet",
  paid: "Paid",
  pending: "Pending",
  uncollectible: "Could not be collected",
  unresolved: "Unresolved in Whop",
  void: "Voided in Whop",
  unknown: "A status the CRM does not know",
};

export const ADVERSE_STATE_LABELS: Record<ProviderPayment["adverseState"], string | null> = {
  none: null,
  refund_pending: "Refund pending",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
  dispute_open: "Dispute open",
  dispute_won: "Dispute won",
  dispute_lost: "Dispute lost",
};

/** "card" -> "Card", "apple_pay" -> "Apple pay". */
export function paymentMethodLabel(type: string | undefined) {
  if (!type) return null;
  const words = type.replaceAll("_", " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
}

/** "Booked", "Follow-up", "Won", from a deal's stage and outcome. */
export function dealStageLabel(stage: DealStage, outcome: DealOutcome) {
  if (stage !== "closed") return DEAL_POSITION_LABELS[stage];
  return outcome === "won" ? DEAL_POSITION_LABELS.won : DEAL_POSITION_LABELS.lost;
}

/** "4 minutes ago", or "just now" inside a minute. */
export function formatSince(at: number, now: number) {
  if (Math.abs(now - at) < 60_000) return "just now";
  return formatDistanceToNowStrict(at, { addSuffix: true });
}

/** How long something has waited: "3 hours", "2 days", or "under a minute". */
export function formatWaitAge(since: number, now: number) {
  if (now - since < 60_000) return "under a minute";
  return formatDistanceStrict(since, now);
}

export const AUTOMATIC_RESULTS_HREF = "/workspace/settings/automatic-results";

const ERROR_SENTENCES: Record<string, string> = {
  "provider_payment.changed": "Someone else changed this payment. Reload to see the current state.",
  "provider_payment.connection_unavailable": "The Whop connection is unavailable.",
  "provider_payment.not_found": "This Whop payment is not in this workspace.",
  "provider_payment.record_not_found": "That CRM payment no longer exists.",
  "provider_payment.already_allocated": "This Whop payment is already tied to a CRM payment.",
  "provider_payment.dismissed": "This Whop payment was dismissed. Reopen it first.",
  "provider_payment.not_paid": "Whop has not marked this payment paid, so it can't be linked.",
  "provider_payment.record_disputed": "That CRM payment is disputed, so it can't take Whop evidence.",
  "provider_payment.record_already_linked": "That CRM payment already has a Whop payment as evidence.",
  "provider_payment.currency_mismatch": "The two payments are in different currencies, so they can't be linked.",
  "provider_payment.unsupported_currency": "Whop's amount is in a currency the CRM can't read, so it can't be linked.",
  "provider_payment.amount_mismatch": "The two amounts differ.",
  "provider_payment.allocation_check_incomplete": "This Whop payment has too many earlier links to check, so nothing was linked.",
  "provider_payment.invalid_record_target": "That CRM payment needs a deal with a current person before it can be linked.",
  "provider_payment.not_manually_linked": "This Whop payment has no link a person made, so there is nothing to unlink.",
  "provider_payment.link_inconsistent": "The Whop payment and the CRM payment no longer point to each other. Nothing changed.",
  "provider_payment.hold_already_cleared": "This Whop hold has already cleared.",
  "provider_payment.not_reviewable": "This Whop payment is no longer waiting for review.",
  "provider_payment.not_dismissed": "This Whop payment is not dismissed.",
};

/** A plain sentence for a failed Whop review action. */
export function providerErrorMessage(error: unknown, fallback: string) {
  const code = getErrorCode(error);
  return (code && ERROR_SENTENCES[code]) || getErrorMessage(error, fallback);
}
