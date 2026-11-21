import type { AutomationCommandCode } from "@/convex/payments/commandResult";

// What a call-result command's refusal means, in one plain sentence each
// (`AutomationCommandCode` in convex/payments/commandResult.ts). Commands
// return `{ ok: false, code }` and write nothing.

export const AUTOMATION_COMMAND_WORDS: Record<AutomationCommandCode, string> = {
  kind_off: "This is turned off for your team right now.",
  stale_preview: "This changed since the page loaded. Check it and try again.",
  not_ready: "This is no longer waiting on you.",
  not_yours: "This deal isn't assigned to you right now.",
  needs_review: "An admin needs to review this now.",
  certificate_required: "This can't run by itself yet.",
  certificate_lapsed: "This can't run by itself right now.",
  notice_not_acknowledged: "Confirm you've seen the notice first.",
  transcript_gone: "The call's transcript was deleted, so this can't be used.",
  time_past: "That time has passed. Pick a later one.",
  open_task: "This deal already has an open task.",
  deal_not_open: "This deal is no longer open.",
  meeting_not_open: "This call's result is already recorded.",
  alert_closed: "This is no longer open.",
};

/** The sentence for a call-result command's refusal code. */
export function automationCommandSentence(code: AutomationCommandCode): string {
  return AUTOMATION_COMMAND_WORDS[code];
}
