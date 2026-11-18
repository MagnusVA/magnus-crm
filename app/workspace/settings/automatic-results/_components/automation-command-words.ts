import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { AutomationCommandCode } from "@/convex/payments/commandResult";

// What a refusal from an Automatic results command means to the owner or an
// admin on this page, one plain sentence per code. Commands return
// `{ ok: false, code }` and write nothing. The closer-facing words live in
// app/workspace/closer/_components/automation-command-words.ts and differ.

export const PANEL_COMMAND_WORDS: Record<AutomationCommandCode, string> = {
  kind_off: "This kind is not at a level that allows it right now. Nothing was changed.",
  stale_preview: "This changed since the page loaded. Check it again and retry.",
  not_ready: "This is no longer waiting for that. Nothing was changed.",
  not_yours: "Your role can't do this one.",
  needs_review: "Something still needs a person first: an open check, an unanswered “This isn't my sale”, or later work on the deal.",
  certificate_required: "This kind has no current clean sample, so it can't record by itself.",
  certificate_lapsed: "The rule changed or the cases grew too old since the sample was graded. A new sample is needed.",
  notice_not_acknowledged: "Someone has to confirm they've seen the notice first.",
  transcript_gone: "The call's transcript was deleted, so this can't be used.",
  time_past: "That time has passed.",
  open_task: "This deal already has an open task.",
  deal_not_open: "The deal is no longer open.",
  meeting_not_open: "The call already has a result.",
  alert_closed: "This is no longer open.",
};

export function panelCommandSentence(code: AutomationCommandCode): string {
  return PANEL_COMMAND_WORDS[code];
}

type CertifyResult = FunctionReturnType<typeof api.automation.certificates.certify>;
export type CertificateFailureCode = Extract<CertifyResult, { ok: false }>["code"];

/** Why a sample can't be certified, one sentence per code from `certify`. */
export const CERTIFY_REFUSAL_WORDS: Record<CertificateFailureCode, string> = {
  no_sample: "There is no sample for this kind.",
  not_full: "The sample is not full yet.",
  ungraded: "Some cases in the sample are not graded yet.",
  wrong: "A case in the sample was graded wrong, so this sample can't be certified.",
  unsure: "A case in the sample is still unsure. Give it a second look first.",
  aged_out: "The oldest cases are more than 12 months old, so the sample dropped out.",
  rule_changed: "The rule changed since the sample was graded.",
};
