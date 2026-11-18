import type { FunctionArgs } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import type { StatusTone } from "@/app/workspace/reports/_components/report-ui";

// The Proposals tab's words: one name per kind of decision read from a call,
// one per state, and one plain sentence per gate that holds a decision back.
// Every sentence about why a proposal waits lives here and nowhere else.

type Decision = Doc<"resultAutomationDecisions">;
export type ProposalKind = NonNullable<FunctionArgs<typeof api.automation.callDecisions.listCallProposals>["kind"]>;
export type ProposalState = Decision["state"];
export type ProposalGate = Decision["gates"][number];
export type ProposalStopCode = NonNullable<Decision["stopCode"]>;

export const PROPOSAL_KIND_WORDS: Record<ProposalKind, string> = {
  call_back: "Call back",
  payment_owed: "Payment owed",
  refusal_loss: "Refused on the call",
  paid_on_call_alert: "Paid on the call, no payment found",
};

export const PROPOSAL_STATE_WORDS: Record<ProposalState, string> = {
  needs_person: "Waiting for a person",
  ready: "Ready to confirm",
  shadow: "Shadow: stored only",
  applied: "Recorded",
  stopped: "Stopped",
  superseded: "Replaced by a newer reading",
  blocked: "Held by a check",
  notice: "Waiting out its notice",
  undone: "Undone",
  corrected: "Corrected",
};

export const PROPOSAL_STATE_TONE: Record<ProposalState, StatusTone> = {
  needs_person: "owed",
  ready: "owed",
  notice: "owed",
  blocked: "failed",
  shadow: "done",
  applied: "live",
  stopped: "done",
  superseded: "done",
  undone: "done",
  corrected: "done",
};

/** The states the filter offers. Shadow rows never reach this list, so it isn't one. */
export const PROPOSAL_STATE_FILTERS: ReadonlyArray<ProposalState> = [
  "needs_person",
  "ready",
  "notice",
  "applied",
  "stopped",
  "superseded",
];

/** States where the gates explain why the proposal is still waiting. */
export const WAITING_STATES = new Set<ProposalState>(["needs_person", "ready", "blocked", "notice"]);

/** Why a decision read from a call waits, one sentence per gate. */
const GATE_SENTENCES: Partial<Record<ProposalGate, string>> = {
  not_whole_call: "The recording is not one whole call.",
  speakers_unclear: "It isn't clear who is speaking on the recording.",
  recording_too_long: "The recording is over two hours long.",
  weak_recording_match: "The recording was not matched to this meeting by email, meeting link or by hand.",
  other_prospect: "The recording may be another prospect's call.",
  transcript_gone: "The transcript has been deleted.",
  slot_not_over: "The call's time slot has not ended yet.",
  checks_incomplete: "Not every check on the call finished.",
  checks_disagree: "The checks on the call disagree with the reading.",
  code_checks_failed: "The reading failed the code checks.",
  result_mismatch: "The suggested result names a different outcome.",
  no_final_statement: "The call has no final statement for this result.",
  not_prospect_words: "The final statement was not the prospect's.",
  closer_disqualified: "The closer ended the sale, so it is not the prospect's refusal.",
  not_final_refusal: "The prospect did not clearly refuse at the end of the call.",
  no_contact_method: "The call didn't settle how to get in touch.",
  no_time: "The call didn't settle a day and time.",
  time_past: "The call-back time has passed.",
  no_amount: "The prospect didn't say the amount.",
  no_currency: "The prospect didn't say the currency.",
  meeting_not_open: "The meeting already has a result.",
  deal_not_open: "The deal is no longer open.",
  side_deal: "This is a side deal.",
  no_closer: "The deal has no closer.",
  open_task: "The deal already has an open task.",
  newer_meeting: "The prospect has a newer meeting.",
  payment_exists: "A payment already counts for this prospect.",
  unresolved_payment: "A Whop payment for this prospect is waiting for review.",
  stood_down: "A person stopped this proposal on this recording before.",
  late_reading: "The call was read more than 72 hours after it happened.",
  not_fresh_read: "The call was read again later, not when the recording arrived.",
  out_of_scope: "This case is outside what the automatic rule covers.",
  mapping_held: "The Whop mapping for this product is held for review.",
  whop_stale: "Whop has not been read recently.",
};

export function gateSentence(gate: ProposalGate): string {
  return GATE_SENTENCES[gate] ?? "A check on this proposal did not pass.";
}

/** Why a stopped proposal stopped, one sentence per stop code. */
const STOP_SENTENCES: Record<ProposalStopCode, string> = {
  human_result: "A person recorded the result.",
  paused: "Automatic results were paused.",
  kind_lowered: "This kind was turned down.",
  person_stop: "A person stopped it.",
  merged: "The prospect was merged into another record.",
  adverse: "A refund or dispute was reported.",
  input_changed: "The call or the deal changed.",
  deal_closed: "The deal was closed.",
  payment_found: "A payment was found.",
  recording_moved: "The recording moved to another meeting.",
  transcript_gone: "The transcript was deleted.",
  closer_changed: "The deal moved to another closer.",
  late_wakeup: "The check ran more than a day late.",
  newer_meeting: "The prospect booked a newer meeting.",
  breaker: "This kind went back to one tap.",
  certificate_lapsed: "This kind's clean record no longer covers the current rule.",
};

export function stopSentence(code: ProposalStopCode): string {
  return STOP_SENTENCES[code];
}
