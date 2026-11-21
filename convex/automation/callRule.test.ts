import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { CALL_FRESH_MS, callRuleVersion, deriveCallDecisions, type CallDecisionInput, type CallKind } from "./callRule";

const NOW = Date.parse("2026-11-17T19:00:00Z");
const HOUR = 3_600_000;
const kinds = ["call_back", "payment_owed", "refusal_loss"] as const;
const endingByKind = { call_back: "call_back", payment_owed: "promised", refusal_loss: "lost" } as const;
const statementByKind = { call_back: "asks_call_back", payment_owed: "promises_payment", refusal_loss: "declines" } as const;

function decisionInput(kind: CallKind): CallDecisionInput {
  const ending = { choice: kind === "payment_owed" ? "paid" : endingByKind[kind], confidence: 0.91 };
  const refusal = kind === "refusal_loss";
  return {
    now: NOW, timeZone: "America/Tegucigalpa", activationVersion: 1,
    modes: {
      call_back: { mode: "ask", policyVersion: 2 },
      payment_owed: { mode: "ask", policyVersion: 3 },
      refusal_loss: { mode: "ask", policyVersion: 4 },
    },
    alert: { mode: "off", policyVersion: 1, graceMinutes: 120 },
    run: {
      _id: "10001callInsightRuns" as Id<"callInsightRuns">, generation: 1, trigger: "recording_matched", kind: "full",
      publishedAt: NOW, speakerUncertain: false,
      config: { promptVersion: "p2", taxonomyVersion: "t2", model: "anthropic/claude-sonnet-5.5", thresholdsVersion: "t1", itemCheck: true, callEvidence: true },
      checks: { wholeCall: 0.95, refused: refusal ? 0.99 : 0.01, disqualified: 0.01, nextStep: 0.91, incomplete: false, version: "cc1" },
      earlyReading: { incomplete: false, ending: { withSummary: ending, withoutSummary: ending } },
      result: { kind: endingByKind[kind], codeChecksPassed: true, failedChecks: [] },
      evidence: {
        recordingScope: "whole", scopeLines: [1, 4], closerStance: "continues",
        prospectStance: refusal ? "refused" : "yes",
        nextStep: refusal ? "none" : kind, nextStepAt: NOW + HOUR, nextStepMethod: "text",
        quotedAmountMinor: 2500, quotedCurrency: "USD",
        statements: [{
          kind: statementByKind[kind], quote: "PRIVATE PROSPECT WORDS", speaker: "Prospect", lineIndex: 4, atSeconds: 100,
          amountMinor: 2500, currency: "USD",
        }],
        dropped: { quoteNotFound: 0, amountNotInQuote: 0, cardNumber: 0, overLimit: 0 },
      },
    },
    recording: { _id: "10002callRecordings" as Id<"callRecordings">, matchMethod: "manual", lengthSeconds: 1500, transcriptGone: false, otherProspect: false },
    meeting: { _id: "10003meetings" as Id<"meetings">, status: "scheduled", scheduledAt: NOW - 3 * HOUR, slotEndedAt: NOW - 2 * HOUR },
    deal: {
      _id: "10004opportunities" as Id<"opportunities">, position: "booked", isSideDeal: false,
      assignedCloserId: "10005users" as Id<"users">, humanResultRevision: 0,
      pendingTasks: [], newerMeeting: false, countingPaymentSinceCall: false, unresolvedProviderPayment: false,
    },
    vetoed: { task: false, refusal: false },
  };
}

type TestGate = {
  gate: ReturnType<typeof deriveCallDecisions>[number]["gates"][number];
  change: (input: CallDecisionInput) => void;
  kinds?: readonly CallKind[];
  automaticOnly?: boolean;
};
const tasks = ["call_back", "payment_owed"] as const;
const refusal = ["refusal_loss"] as const;
const owed = ["payment_owed"] as const;
const gates: TestGate[] = [
  { gate: "recording_too_long", change: (a) => { a.recording.lengthSeconds = 7200.01; } },
  { gate: "weak_recording_match", change: (a) => { a.recording.matchMethod = "time_only"; } },
  { gate: "other_prospect", change: (a) => { a.recording.otherProspect = true; } },
  { gate: "transcript_gone", change: (a) => { a.recording.transcriptGone = true; } },
  { gate: "not_whole_call", change: (a) => { a.run.evidence!.recordingScope = "cut_off"; } },
  { gate: "not_whole_call", change: (a) => { a.run.checks!.wholeCall = 0.79; } },
  { gate: "speakers_unclear", change: (a) => { a.run.speakerUncertain = true; } },
  { gate: "checks_incomplete", change: (a) => { a.run.checks!.incomplete = true; } },
  { gate: "checks_incomplete", change: (a) => { a.run.earlyReading!.incomplete = true; } },
  { gate: "checks_incomplete", change: (a) => { delete a.run.checks; } },
  { gate: "code_checks_failed", change: (a) => { a.run.result = { ...a.run.result!, codeChecksPassed: false, failedChecks: ["amount_not_in_quote"] }; } },
  { gate: "result_mismatch", change: (a) => { a.run.result!.kind = "no_decision"; } },
  { gate: "checks_disagree", change: (a) => { a.run.earlyReading!.ending!.withSummary = { choice: "undecided", confidence: 0.6 }; } },
  { gate: "checks_disagree", kinds: ["call_back", "refusal_loss"], change: (a) => { a.run.earlyReading!.ending!.withoutSummary!.confidence = 0.79; } },
  { gate: "checks_disagree", kinds: tasks, change: (a) => { a.run.checks!.nextStep = 0.79; } },
  { gate: "no_final_statement", change: (a) => { a.run.evidence!.statements.push({ ...a.run.evidence!.statements[0], kind: "defers", lineIndex: 5 }); } },
  { gate: "no_final_statement", change: (a) => { a.run.evidence!.statements[0].quote = ""; } },
  { gate: "not_prospect_words", change: (a) => { a.run.evidence!.statements[0].speaker = "Closer"; } },
  { gate: "closer_disqualified", kinds: refusal, change: (a) => { a.run.evidence!.closerStance = "disqualified"; } },
  { gate: "closer_disqualified", kinds: refusal, change: (a) => { a.run.checks!.disqualified = 0.21; } },
  { gate: "not_final_refusal", kinds: refusal, change: (a) => { a.run.evidence!.prospectStance = "undecided"; } },
  { gate: "not_final_refusal", kinds: refusal, change: (a) => { a.run.checks!.refused = 0.79; } },
  { gate: "no_contact_method", kinds: tasks, change: (a) => { delete a.run.evidence!.nextStepMethod; } },
  { gate: "no_time", kinds: tasks, change: (a) => { delete a.run.evidence!.nextStepAt; } },
  { gate: "time_past", kinds: tasks, change: (a) => { a.run.evidence!.nextStepAt = a.now; } },
  { gate: "no_amount", kinds: owed, change: (a) => { a.run.evidence!.quotedAmountMinor = 0; } },
  { gate: "no_amount", kinds: owed, change: (a) => { delete a.run.evidence!.statements[0].amountMinor; } },
  { gate: "no_currency", kinds: owed, change: (a) => { delete a.run.evidence!.quotedCurrency; } },
  { gate: "no_currency", kinds: owed, change: (a) => { a.run.evidence!.quotedCurrencyAssumed = true; } },
  { gate: "no_currency", kinds: owed, change: (a) => { a.run.evidence!.statements[0].currencyAssumed = true; } },
  { gate: "slot_not_over", change: (a) => { a.meeting.slotEndedAt = a.now + 1; } },
  { gate: "meeting_not_open", change: (a) => { a.meeting.status = "held"; } },
  { gate: "deal_not_open", change: (a) => { a.deal!.position = "won"; } },
  { gate: "deal_not_open", kinds: refusal, change: (a) => { a.deal!.humanResultRevision = 1; } },
  { gate: "side_deal", change: (a) => { a.deal!.isSideDeal = true; } },
  { gate: "no_closer", change: (a) => { delete a.deal!.assignedCloserId; } },
  { gate: "open_task", change: (a) => { a.deal!.pendingTasks = [{ _id: "10006followUps" as Id<"followUps"> }]; } },
  { gate: "newer_meeting", change: (a) => { a.deal!.newerMeeting = true; } },
  { gate: "payment_exists", change: (a) => { a.deal!.countingPaymentSinceCall = true; } },
  { gate: "unresolved_payment", kinds: refusal, change: (a) => { a.deal!.unresolvedProviderPayment = true; } },
  { gate: "stood_down", change: (a) => { a.vetoed = { task: true, refusal: true }; } },
  { gate: "late_reading", automaticOnly: true, change: (a) => { a.run.publishedAt = a.meeting.slotEndedAt + CALL_FRESH_MS + 1; } },
  { gate: "not_fresh_read", automaticOnly: true, change: (a) => { a.run.trigger = "backfill"; } },
  { gate: "not_fresh_read", automaticOnly: true, change: (a) => { a.run.trigger = "read_again"; } },
];

describe("deriveCallDecisions", () => {
  it.each(kinds)("has a single clean, wordless %s candidate", (kind) => {
    const a = decisionInput(kind);
    const decisions = deriveCallDecisions(a);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ kind, askable: true, wouldWrite: true, gates: [], finalStatementLine: 4 });
    expect(decisions[0].proposal).toBeDefined();
    expect(JSON.stringify(decisions)).not.toContain("PRIVATE PROSPECT WORDS");
  });

  it.each(gates.flatMap(({ kinds: affected, ...row }) => (affected ?? kinds).map((kind) => ({ ...row, kind }))))(
    "$kind records $gate",
    ({ gate, change, kind, automaticOnly }) => {
      const a = decisionInput(kind);
      change(a);
      const [decision] = deriveCallDecisions(a);
      expect(decision.gates).toContain(gate);
      expect(decision.gates).toEqual([...decision.gates].sort());
      expect(decision.askable).toBe(automaticOnly ?? false);
      expect(decision.wouldWrite).toBe(false);
      expect(Boolean(decision.proposal)).toBe(automaticOnly ?? false);
    },
  );

  it("rechecks the call-back time at evaluation without inheriting the suggestion's time check", () => {
    const a = decisionInput("call_back");
    a.run.result = { ...a.run.result!, codeChecksPassed: false, failedChecks: ["callback_not_future"] };
    const [before] = deriveCallDecisions(a);
    expect(before.gates).toEqual([]);
    expect(before.proposal).toMatchObject({ reminderScheduledAt: NOW + HOUR });
    const [intermediate] = deriveCallDecisions({ ...a, now: NOW + 1 });
    expect(intermediate.inputTuple).toEqual(before.inputTuple);
    const [after] = deriveCallDecisions({ ...a, now: NOW + HOUR });
    expect(after.gates).toEqual(["time_past"]);
    expect(after.proposal).toBeUndefined();
    expect(after.vetoTuple).toEqual(before.vetoTuple);
  });

  it("lets weak promised-payment readings abstain from agreement but never disagree at the conflict threshold", () => {
    const a = decisionInput("payment_owed");
    a.run.earlyReading!.ending!.withoutSummary = { choice: "no_decision", confidence: 0.59 };
    a.deal!.declineCode = "insufficient_funds";
    expect(deriveCallDecisions(a)[0].proposal).toMatchObject({
      type: "task", purpose: "payment_owed", expectedAmountMinor: 2500, expectedCurrency: "USD",
      contactMethod: "text", promisedPaymentAt: NOW + HOUR, declineCode: "insufficient_funds",
    });
    a.deal!.declineCode = "arbitrary provider text";
    expect(deriveCallDecisions(a)[0].proposal).not.toHaveProperty("declineCode");
    a.run.earlyReading!.ending!.withoutSummary!.confidence = 0.6;
    expect(deriveCallDecisions(a)[0].gates).toContain("checks_disagree");
  });

  it("uses inclusive pass thresholds and a strict freshness cutoff", () => {
    const a = decisionInput("refusal_loss");
    a.run.checks = { version: "cc1", wholeCall: 0.8, refused: 0.8, disqualified: 0.2, incomplete: false };
    a.run.earlyReading!.ending!.withSummary!.confidence = 0.8;
    a.run.earlyReading!.ending!.withoutSummary!.confidence = 0.8;
    a.run.publishedAt = a.meeting.slotEndedAt + CALL_FRESH_MS;
    a.recording.lengthSeconds = 7200;
    a.run.trigger = "sweep";
    expect(deriveCallDecisions(a)[0].gates).toEqual([]);
  });

  it.each(["no_decision", "none"] as const)("does not classify silence or disqualification with result %s", (kind) => {
    const a = decisionInput("refusal_loss");
    a.run.result!.kind = kind;
    a.run.evidence!.statements[0].kind = "disqualifies";
    a.run.evidence!.statements[0].speaker = "Closer";
    expect(deriveCallDecisions(a)).toEqual([]);
  });

  it("skips an attendance-only run, a p1 run without evidence, and an off kind", () => {
    const a = decisionInput("call_back");
    expect(deriveCallDecisions({ ...a, run: { ...a.run, kind: "attendance_only" } })).toEqual([]);
    expect(deriveCallDecisions({ ...a, run: { ...a.run, evidence: undefined, config: { ...a.run.config, callEvidence: undefined } } })).toEqual([]);
    a.modes.call_back.mode = "off";
    expect(deriveCallDecisions(a)).toEqual([]);
  });

  it("derives a separate wordless alert from the closer's last money statement after grace", () => {
    const a = decisionInput("call_back");
    a.alert.mode = "on";
    const evidence = a.run.evidence!;
    evidence.statements.push({ ...evidence.statements[0], speaker: "Closer", lineIndex: 5, kind: "payment_seen" });
    const [task, alert] = deriveCallDecisions(a);
    expect(task.kind).toBe("call_back");
    expect(alert).toMatchObject({ kind: "paid_on_call_alert", askable: true, wouldWrite: true, dueAt: NOW, finalStatementLine: 5 });
    expect(deriveCallDecisions({ ...a, now: NOW - 1 }).map(({ kind }) => kind)).toEqual(["call_back"]);
    a.deal!.alertPaymentExists = true;
    expect(deriveCallDecisions(a)[1]).toMatchObject({ gates: ["payment_exists"], askable: false });
    evidence.statements.push({ ...evidence.statements[0], lineIndex: 6, kind: "payment_failed" });
    expect(deriveCallDecisions(a)).toHaveLength(1);
  });

  it("changes the rule version when the prompt, model, or checks change", () => {
    const config = decisionInput("call_back").run.config;
    expect(callRuleVersion({ ...config, checksVersion: "cc1" })).toBe("call-rule@1|p2|anthropic/claude-sonnet-5.5|t1|cc1");
    const before = callRuleVersion({ ...config, checksVersion: "cc1" });
    for (const change of [{ promptVersion: "p3" }, { model: "anthropic/new-extraction-model" }, { thresholdsVersion: "t2" }, { checksVersion: "cc2" }]) {
      expect(callRuleVersion({ ...config, checksVersion: "cc1", ...change })).not.toBe(before);
    }
  });
});
