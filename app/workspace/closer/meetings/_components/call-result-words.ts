import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { AutomationCommandCode } from "@/convex/payments/commandResult";
import { gateSentence } from "@/app/workspace/pipeline/call-insights/_components/proposal-words";
import { getErrorMessage } from "@/lib/errors";

// The meeting result area's words for results read from a recorded call: one
// plain sentence per refusal code, the decline reasons, and the small
// formatters the ask, the notice and the summary share. Gate sentences come
// from the Proposals tab's words.

export type CallAsk = NonNullable<FunctionReturnType<typeof api.automation.confirmCall.getCallAsk>>;
export type CallResultSummaryData = NonNullable<
  FunctionReturnType<typeof api.automation.confirmCall.getCallResultSummary>
>;
export type CallQuote = CallAsk["quotes"][number];
export type ContactMethod = "call" | "text";

/** What a call-result command returns when it refuses, one sentence per code. */
const CODE_SENTENCES: Record<AutomationCommandCode, string> = {
  kind_off: "Results from calls are turned off for this kind. Record the result yourself.",
  stale_preview: "The call was read again. Check the new proposal.",
  not_ready: "This proposal is no longer waiting for an answer.",
  not_yours: "Only the deal's closer, an admin or the owner can answer this.",
  needs_review: "Something changed since this was set. An admin can correct it from the deal.",
  certificate_required: "This kind has no clean record yet, so it can't run by itself.",
  certificate_lapsed: "This kind's clean record no longer covers the current rule.",
  notice_not_acknowledged: "Nobody has confirmed seeing this notice yet.",
  transcript_gone: "The transcript was deleted, so this can't be confirmed in one tap.",
  time_past: "That time has passed. Pick a later time.",
  open_task: "The deal already has an open task. Finish or cancel it first.",
  deal_not_open: "The deal is no longer open.",
  meeting_not_open: "The meeting already has a result, or the call hasn't started yet.",
  alert_closed: "This alert is already closed.",
};

export function automationCodeSentence(code: AutomationCommandCode): string {
  return CODE_SENTENCES[code];
}

/** A thrown error (auth, network): the server's own words when it sent some. */
export function thrownSentence(error: unknown): string {
  return getErrorMessage(error, "That didn't save. Please try again.");
}

/** Why no one tap is offered for this call: one quiet line, or none. */
export function noOneTapLine(ask: CallAsk): string | null {
  if (ask.state === "notice") return null;
  if (ask.state === "ready" && ask.can.confirm) return null;
  if (ask.quotesDeleted) return "No one tap for this call: the quote was deleted with the transcript.";
  const gate = ask.gates[0];
  if (ask.state === "needs_person" && gate) return `No one tap for this call. ${gateSentence(gate)}`;
  return null;
}

/** The ask or the notice takes the place of today's suggestion card. */
export function callAskReplacesSuggestion(ask: CallAsk | null | undefined): boolean {
  if (!ask) return false;
  return ask.state === "notice" || (ask.state === "ready" && ask.can.confirm);
}

export const CONTACT_METHOD_WORDS: Record<ContactMethod, string> = {
  call: "by call",
  text: "by text",
};

/** Fixed decline codes from Whop; anything else reads as a plain decline. */
const DECLINE_WORDS: Record<string, string> = {
  insufficient_funds: "Insufficient funds",
  bank_insufficient_funds: "Insufficient funds in the bank account",
  lost_card: "The card was reported lost",
  stolen_card: "The card was reported stolen",
  expired_card: "The card has expired",
  suspected_fraud: "Declined as suspected fraud",
  invalid_card_number: "The card number is invalid",
  invalid_cvc: "The security code is wrong",
  incorrect_pin: "The PIN is wrong",
  authentication_required: "The bank asked for verification",
  three_d_secure_failed: "The bank's verification failed",
  card_not_supported: "The card type isn't supported",
  currency_not_supported: "The card doesn't support this currency",
  duplicate_transaction: "Declined as a duplicate payment",
  generic_decline: "The card was declined",
  card_declined_by_issuer: "The card's bank declined it",
  bank_declined: "The bank declined it",
  provider_declined: "Whop declined it",
  invalid_account: "The account is invalid",
  invalid_amount: "The amount was rejected",
  processing_error: "A processing error",
  restricted_card: "The card is restricted",
  issuer_unavailable: "The card's bank was unavailable",
  high_risk: "Declined as high risk",
  try_again_later: "Declined for now; trying again later may work",
  bank_account_closed: "The bank account is closed",
  bank_payment_stopped: "The bank stopped the payment",
  other: "The payment was declined",
};

export function declineWords(code: string): string {
  return DECLINE_WORDS[code] ?? "The payment was declined";
}

/** Where in the call a line was said: "38:12", or "1:02:05" past the hour. */
export function callClock(atSeconds: number): string {
  const total = Math.max(0, Math.floor(atSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

const SPEAKER_WORDS: Record<CallQuote["speaker"], string> = {
  Closer: "Closer",
  Prospect: "Prospect",
  Other: "Someone else on the call",
};

export function speakerWords(speaker: CallQuote["speaker"]): string {
  return SPEAKER_WORDS[speaker];
}

/** "Checked" for an ask or a notice: what had to hold before it was offered. */
export function checkedLine(kind: CallAsk["kind"]): string {
  switch (kind) {
    case "refusal_loss":
      return "One whole call · Jev agrees the prospect refused";
    case "payment_owed":
      return "One whole call · Jev agrees a payment is owed";
    case "call_back":
      return "One whole call · Jev agrees on the call-back";
  }
}

/** "Recorded automatically" or "Confirmed by Dee", capitalized from the server's byline. */
export function summaryByline(summary: CallResultSummaryData): string {
  if (summary.byline) return summary.byline.charAt(0).toUpperCase() + summary.byline.slice(1);
  if (summary.entry === "automatic") return "Recorded automatically";
  return `Confirmed by ${summary.resolvedByName ?? "a team member"}`;
}
