import { describe, expect, it } from "vitest";
import {
  buildCallCheckRequests,
  callCheckProposal,
  combineCallChecks,
} from "./callChecks";
import type { CallEvidence } from "./validators";
import type { PreparedLine } from "./transcriptPrep";

const lines: PreparedLine[] = Array.from({ length: 18 }, (_, i) => ({
  index: i + 1,
  atSeconds: i,
  at: "00:00",
  text: `Synthetic line ${i + 1}.`,
  isCloserKey: false,
  role: "Prospect",
  speakerKey: "invented",
}));
const evidence: CallEvidence = {
  recordingScope: "whole",
  scopeLines: [1, 18],
  prospectStance: "undecided",
  closerStance: "continues",
  nextStep: "call_back",
  nextStepMethod: "text",
  nextStepAt: Date.parse("2026-11-11T21:00:00Z"),
  statements: [
    {
      kind: "asks_call_back",
      lineIndex: 14,
      speaker: "Prospect",
      atSeconds: 13,
      quote: "Synthetic line 14.",
    },
  ],
  dropped: {
    quoteNotFound: 0,
    amountNotInQuote: 0,
    cardNumber: 0,
    overLimit: 0,
  },
};

describe("call checks", () => {
  it("asks whole-call questions and reads ten lines before the final statement through the last line for the next step", () => {
    const [call, ending] = buildCallCheckRequests({
      evidence,
      lines,
      proposal: callCheckProposal(evidence),
      timeContext: {
        callDateIso: "2026-11-10",
        timeZone: "America/Tegucigalpa",
      },
    });
    expect(call.key).toBe("call");
    expect(Object.keys(call.request.questions)).toEqual([
      "whole_call",
      "refused",
      "disqualified",
    ]);
    expect(call.request.questions.refused.instructions).toContain(
      "their own words",
    );
    expect(call.request.questions.disqualified.instructions).toContain(
      "closer ended",
    );
    expect(call.request.state).toContain("#1 ");
    expect(call.request.state).toContain("#18 ");
    expect(ending.key).toBe("next_step");
    expect(ending.request.state).toContain("#4 ");
    expect(ending.request.state).toContain("#18 ");
    expect(ending.request.state).not.toContain("#3 ");
    expect(ending.request.state).toContain("2026-11-10");
    expect(ending.request.questions.next_step.instructions).toContain(
      "text message",
    );
    expect(ending.request.questions.next_step.instructions).toContain(
      "November 11, 2026 at 3:00:00 PM",
    );
  });

  it("includes the exact amount and currency of a payment proposal", () => {
    const payment: CallEvidence = {
      ...evidence,
      nextStep: "payment_owed",
      quotedAmountMinor: 20_050,
      quotedCurrency: "CAD",
    };
    const requests = buildCallCheckRequests({
      evidence: payment,
      lines,
      proposal: callCheckProposal(payment),
    });
    expect(requests[1].request.questions.next_step.instructions).toContain(
      "paying 200.50 CAD",
    );
  });

  it("asks only the whole-call questions when the exact next step is unavailable", () => {
    const partial = { ...evidence, nextStepMethod: undefined };
    expect(
      buildCallCheckRequests({
        evidence: partial,
        lines,
        proposal: callCheckProposal(partial),
      }).map(({ key }) => key),
    ).toEqual(["call"]);
  });

  it("keeps independent scores and marks unanswered requests incomplete", () => {
    const call = {
      key: "call",
      answers: {
        whole_call: { noul: 1 },
        refused: { noul: 0 },
        disqualified: { noul: 0.1 },
      },
    };
    expect(
      combineCallChecks(
        [call, { key: "next_step", answers: { next_step: { noul: 0.9 } } }],
        false,
      ),
    ).toEqual({
      version: "cc1",
      wholeCall: 1,
      refused: 0,
      disqualified: 0.1,
      nextStep: 0.9,
      incomplete: false,
    });
    expect(combineCallChecks([call], true)).toMatchObject({ incomplete: true });
    expect(combineCallChecks([], false)).toEqual({
      version: "cc1",
      incomplete: true,
    });
  });
});
