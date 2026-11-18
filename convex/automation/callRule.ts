import type { Doc, Id } from "../_generated/dataModel";
import type { CallChecks, CallEvidence, EarlyReading, ResultEvidence, RunConfig } from "../callInsights/validators";
import type { DealPosition } from "../opportunities/stages";
import type { AlertProposal, AutomationMode, CallKind, RefusalProposal, TaskProposal } from "./proposals";

export type { CallKind } from "./proposals";

export const CALL_RULE_VERSION = "call-rule@1";
export const CALL_FRESH_MS = 72 * 3_600_000;
export const MAX_RECORDING_SECONDS = 7_200;
export const PASS = 0.8;
export const CONFLICT = 0.6;
export const DISQUALIFIED_MAX = 0.2;

type CallVersion = Pick<RunConfig, "promptVersion" | "model" | "thresholdsVersion"> & { checksVersion: string };

export function callRuleVersion({ promptVersion, model, thresholdsVersion, checksVersion }: CallVersion): string {
  return [CALL_RULE_VERSION, promptVersion, model, thresholdsVersion, checksVersion].join("|");
}

type Gate = Doc<"resultAutomationDecisions">["gates"][number];
type CallDecisionKind = CallKind | "paid_on_call_alert";
type Policy<Mode> = { mode: Mode; policyVersion: number };

export type CallDecisionInput = {
  now: number;
  timeZone: string;
  modes: Record<CallKind, Policy<AutomationMode>>;
  alert: Policy<"off" | "shadow" | "on"> & { graceMinutes: number };
  activationVersion: number;
  run: Pick<Doc<"callInsightRuns">, "_id" | "generation" | "trigger" | "kind"> & {
    config: RunConfig;
    publishedAt: number;
    publicationRevision?: number;
    speakerUncertain: boolean;
    evidence?: CallEvidence;
    checks?: CallChecks;
    result?: Pick<ResultEvidence, "kind" | "codeChecksPassed" | "failedChecks">;
    earlyReading?: EarlyReading;
  };
  recording: {
    _id: Id<"callRecordings">;
    matchMethod?: string;
    lengthSeconds: number;
    transcriptGone: boolean;
    otherProspect: boolean;
  };
  meeting: Pick<Doc<"meetings">, "_id" | "status" | "scheduledAt"> & { slotEndedAt: number };
  deal: null | {
    _id: Id<"opportunities">;
    position: DealPosition;
    isSideDeal: boolean;
    assignedCloserId?: Id<"users">;
    humanResultRevision: number;
    humanResultRecorded?: boolean;
    pendingTasks: { _id: Id<"followUps">; purpose?: string }[];
    newerMeeting: boolean;
    countingPaymentSinceCall: boolean;
    countingPaymentForRefusal?: boolean;
    unresolvedProviderPayment: boolean;
    alertPaymentExists?: boolean;
    declineCode?: string;
  };
  vetoed: { task: boolean; refusal: boolean };
  releasedVeto?: Partial<Record<"task" | "refusal", Id<"resultAutomationDecisions">>>;
};

export type DerivedCallDecision = {
  kind: CallDecisionKind;
  askable: boolean;
  wouldWrite: boolean;
  gates: Gate[];
  proposal?: TaskProposal | RefusalProposal | AlertProposal;
  noticeUserId?: Id<"users">;
  dueAt?: number;
  finalStatementLine?: number;
  inputTuple: readonly (string | number | boolean | null)[];
  vetoTuple: readonly string[];
};

const statementByKind = { call_back: "asks_call_back", payment_owed: "promises_payment", refusal_loss: "declines" } as const;
const resultByKind = { call_back: "call_back", payment_owed: "promised", refusal_loss: "lost" } as const;
const callKinds = ["call_back", "payment_owed", "refusal_loss"] as const;
const decisionStatements = new Set<CallEvidence["statements"][number]["kind"]>([
  "asks_call_back", "promises_payment", "declines", "agrees_to_buy", "defers", "disqualifies",
]);
const moneyStatements = new Set<CallEvidence["statements"][number]["kind"]>([
  "states_price", "payment_attempt", "payment_seen", "payment_failed", "promises_payment",
]);
const strongMatches = new Set(["time_email", "time_url", "manual"]);
const automaticOnly = new Set<Gate>(["late_reading", "not_fresh_read"]);

// Fixed codes from Whop normalization. Do not copy arbitrary provider text.
const declineCodes = new Set([
  "insufficient_funds", "lost_card", "stolen_card", "expired_card",
  "suspected_fraud", "invalid_card_number", "invalid_cvc", "incorrect_pin",
  "authentication_required", "card_not_supported", "currency_not_supported",
  "duplicate_transaction", "generic_decline", "invalid_account", "invalid_amount",
  "processing_error", "restricted_card", "card_declined_by_issuer",
  "bank_declined", "issuer_unavailable", "three_d_secure_failed",
  "provider_declined", "high_risk", "try_again_later",
  "bank_insufficient_funds", "bank_account_closed", "bank_payment_stopped", "other",
]);

function matchGates(input: CallDecisionInput): Gate[] {
  const { recording, run } = input;
  const gates: Gate[] = [];
  if (recording.lengthSeconds > MAX_RECORDING_SECONDS) gates.push("recording_too_long");
  if (!strongMatches.has(recording.matchMethod ?? "")) gates.push("weak_recording_match");
  if (recording.otherProspect) gates.push("other_prospect");
  if (recording.transcriptGone) gates.push("transcript_gone");
  if (run.speakerUncertain) gates.push("speakers_unclear");
  return gates;
}

function buildDecision(
  input: CallDecisionInput,
  kind: CallDecisionKind,
  gates: Gate[],
  finalStatementLine: number | undefined,
  candidate?: DerivedCallDecision["proposal"],
  dueAt?: number,
): DerivedCallDecision {
  const { run, meeting, recording, deal, activationVersion } = input;
  const askable = gates.every((gate) => automaticOnly.has(gate));
  const proposal = askable ? candidate : undefined;
  const policyVersion = kind === "paid_on_call_alert" ? input.alert.policyVersion : input.modes[kind].policyVersion;
  const version = callRuleVersion({ ...run.config, checksVersion: run.checks?.version ?? "cc0" });
  const family = kind === "paid_on_call_alert" ? "alert" : kind === "refusal_loss" ? "refusal" : "task";
  const proposalParts = proposal?.type === "task" ? [
    proposal.contactMethod, proposal.reminderScheduledAt, proposal.expectedAmountMinor ?? null,
    proposal.expectedCurrency ?? null, proposal.promisedPaymentAt ?? null, proposal.declineCode ?? null,
  ] : proposal?.type === "alert" ? [proposal.graceEndsAt] : [];
  gates.sort();

  return {
    kind,
    askable,
    wouldWrite: gates.length === 0,
    gates,
    proposal,
    noticeUserId: proposal?.closerId,
    dueAt,
    finalStatementLine,
    inputTuple: [
      "call", kind, version, policyVersion, activationVersion, run._id, run.generation,
      run.publicationRevision ?? 0, meeting._id, deal?._id ?? null, deal?.assignedCloserId ?? null,
      deal?.humanResultRevision ?? 0, meeting.scheduledAt, meeting.slotEndedAt,
      family === "alert" ? null : input.releasedVeto?.[family] ?? null, ...proposalParts, ...gates,
    ],
    vetoTuple: ["call", recording._id, deal?._id ?? "", family],
  };
}

function deriveOutcome(input: CallDecisionInput, kind: CallKind, final: CallEvidence["statements"][number] | undefined) {
  const { now, run, meeting, deal, vetoed } = input;
  const { evidence, checks, result, earlyReading } = run;
  const refusal = kind === "refusal_loss";
  const expected = resultByKind[kind];
  const endings = [earlyReading?.ending?.withSummary, earlyReading?.ending?.withoutSummary];
  // Jev groups payment details and payment under "paid". The exact next-step
  // check distinguishes a quoted promise from cash collected.
  const expectedJev = kind === "payment_owed" ? "paid" : expected;
  const gates = matchGates(input);

  if (evidence?.recordingScope !== "whole" || (checks?.wholeCall ?? 0) < PASS) gates.push("not_whole_call");
  if (!checks || checks.incomplete || checks.wholeCall === undefined || checks.refused === undefined ||
      checks.disqualified === undefined || (!refusal && checks.nextStep === undefined) ||
      !earlyReading || earlyReading.incomplete || endings.some((ending) => ending?.confidence === undefined)) {
    gates.push("checks_incomplete");
  }
  const onlyOldCallbackCheck = kind === "call_back" && result?.failedChecks.length === 1 &&
    result.failedChecks[0] === "callback_not_future";
  if (!result?.codeChecksPassed && !onlyOldCallbackCheck) gates.push("code_checks_failed");
  if (result?.kind !== expected) gates.push("result_mismatch");
  if (
    endings.some((ending) => ending && ending.choice !== expectedJev && (ending.confidence ?? 0) >= CONFLICT) ||
    (kind !== "payment_owed" && !endings.every((ending) => ending?.choice === expectedJev && (ending.confidence ?? 0) >= PASS)) ||
    (!refusal && (checks?.nextStep ?? 0) < PASS)
  ) gates.push("checks_disagree");

  if (final?.kind !== statementByKind[kind] || !final.quote.trim()) gates.push("no_final_statement");
  if (final && final.speaker !== "Prospect") gates.push("not_prospect_words");

  let proposal: TaskProposal | RefusalProposal | undefined;
  const closerId = deal?.assignedCloserId;
  const meetingId = meeting._id;
  if (refusal) {
    if (evidence?.closerStance === "disqualified" || (checks?.disqualified ?? 0) > DISQUALIFIED_MAX) {
      gates.push("closer_disqualified");
    }
    if (evidence?.prospectStance !== "refused" || (checks?.refused ?? 0) < PASS) gates.push("not_final_refusal");
    if (closerId) proposal = { type: "refusal", closerId, meetingId };
  } else {
    const step = evidence?.nextStep === kind ? evidence : undefined;
    const method = step?.nextStepMethod;
    const at = step?.nextStepAt;
    if (!method) gates.push("no_contact_method");
    if (at === undefined || !Number.isFinite(at)) gates.push("no_time");
    else if (at <= Math.max(meeting.slotEndedAt, now)) gates.push("time_past");
    if (closerId && method && at !== undefined) {
      proposal = { type: "task", purpose: kind, closerId, meetingId, contactMethod: method, reminderScheduledAt: at };
    }
    if (kind === "payment_owed") {
      const amount = evidence?.quotedAmountMinor;
      const currency = evidence?.quotedCurrency;
      const quotedByProspect = evidence?.statements.filter((statement) =>
        statement.speaker === "Prospect" && statement.amountMinor === amount && statement.quote.trim()) ?? [];
      if (amount === undefined || !Number.isSafeInteger(amount) || amount <= 0 || quotedByProspect.length === 0) {
        gates.push("no_amount");
      }
      if (!currency || !/^[A-Z]{3}$/.test(currency) || evidence?.quotedCurrencyAssumed ||
          !quotedByProspect.some((statement) => statement.currency === currency && !statement.currencyAssumed)) {
        gates.push("no_currency");
      }
      if (proposal?.type === "task" && at !== undefined) {
        const code = deal?.declineCode;
        proposal.expectedAmountMinor = amount;
        proposal.expectedCurrency = currency;
        proposal.promisedPaymentAt = at;
        if (code && declineCodes.has(code)) proposal.declineCode = code;
      }
    }
  }

  if (now < meeting.slotEndedAt) gates.push("slot_not_over");
  if (meeting.status !== "scheduled") gates.push("meeting_not_open");
  if (!deal || (deal.position !== "booked" && deal.position !== "follow_up") ||
      (refusal && (deal.humanResultRecorded ?? deal.humanResultRevision > 0))) gates.push("deal_not_open");
  if (deal?.isSideDeal) gates.push("side_deal");
  if (!closerId) gates.push("no_closer");
  if (deal?.pendingTasks.length) gates.push("open_task");
  if (deal?.newerMeeting) gates.push("newer_meeting");
  if (refusal
    ? (deal?.countingPaymentForRefusal ?? deal?.countingPaymentSinceCall)
    : deal?.countingPaymentSinceCall) gates.push("payment_exists");
  if (refusal && deal?.unresolvedProviderPayment) gates.push("unresolved_payment");
  if (refusal ? vetoed.refusal : vetoed.task) gates.push("stood_down");
  if (run.publishedAt - meeting.slotEndedAt > CALL_FRESH_MS) gates.push("late_reading");
  if (run.trigger !== "recording_matched" && run.trigger !== "sweep") gates.push("not_fresh_read");

  return buildDecision(input, kind, gates, final?.lineIndex, proposal);
}

/** Read the final decision and money statements independently. All output is wordless. */
export function deriveCallDecisions(input: CallDecisionInput): DerivedCallDecision[] {
  const { run, alert, meeting, deal } = input;
  if (run.kind !== "full" || (!run.config.callEvidence && !run.evidence)) return [];

  const decisions: DerivedCallDecision[] = [];
  const final = run.evidence?.statements.findLast((statement) => decisionStatements.has(statement.kind));
  const kind = callKinds.find((kind) => statementByKind[kind] === final?.kind) ??
    callKinds.find((kind) => resultByKind[kind] === run.result?.kind);
  if (kind && input.modes[kind].mode !== "off") decisions.push(deriveOutcome(input, kind, final));

  const dueAt = meeting.slotEndedAt + alert.graceMinutes * 60_000;
  if (alert.mode !== "off" && input.now >= dueAt) {
    const lastMoney = run.evidence?.statements.findLast((statement) => moneyStatements.has(statement.kind));
    const closerId = deal?.assignedCloserId;
    if (lastMoney?.kind === "payment_seen" && lastMoney.speaker === "Closer" && lastMoney.quote.trim() && closerId) {
      const gates = matchGates(input);
      if (deal.alertPaymentExists ?? deal.countingPaymentSinceCall) gates.push("payment_exists");
      decisions.push(buildDecision(input, "paid_on_call_alert", gates, lastMoney.lineIndex, {
        type: "alert", closerId, meetingId: meeting._id, graceEndsAt: dueAt,
      }, dueAt));
    }
  }
  return decisions;
}
