import { describe, expect, it } from "vitest";
import { buildDecisionsRequest, callDecisions, parseDecisionsResponse } from "./jev";
import { claimFor } from "./questions";
import { buildState, labelSpeakers, measureEvidence } from "./transcript";
import { computeVerdict, type Answers } from "./verdict";

const answers = (over: Partial<Answers> = {}): Answers => ({
  attendance: { choice: "held", confidence: 0.98 },
  ending: { choice: "call_back", confidence: 0.84 },
  objection: { choice: "partner", confidence: 0.77 },
  claim: 0.91,
  ...over,
});

describe("claimFor", () => {
  it("writes one statement per kind of record", () => {
    expect(claimFor({ kind: "payment", amountMinor: 450000, currency: "USD", paymentType: "pif" })).toBe(
      "On this call the prospect agreed to pay $4,500 today, in full.",
    );
    expect(claimFor({ kind: "payment", amountMinor: 50000, currency: "USD", paymentType: "deposit" })).toContain(
      "as a deposit",
    );
    expect(claimFor({ kind: "call_back" })).toBe("The prospect agreed to talk again before deciding.");
    expect(claimFor({ kind: "no_show" })).toBe("The prospect never joined the call.");
    expect(claimFor({ kind: "lost", lossReason: "Price" })).toContain("Price");
    expect(claimFor(undefined)).toBeUndefined();
  });
});

describe("computeVerdict", () => {
  it("agrees when every answer fits the record", () => {
    expect(computeVerdict({ kind: "call_back" }, answers())).toBe("agrees");
  });
  it("disagrees with a no-show the recording disproves", () => {
    expect(
      computeVerdict({ kind: "no_show" }, answers({ attendance: { choice: "held", confidence: 0.96 }, claim: 0.03 })),
    ).toBe("disagrees");
  });
  it("disagrees at the 0.8 edge and is not sure just below it", () => {
    const record = { kind: "lost" as const };
    expect(computeVerdict(record, answers({ ending: { choice: "call_back", confidence: 0.8 }, claim: 0.6 }))).toBe(
      "disagrees",
    );
    expect(computeVerdict(record, answers({ ending: { choice: "call_back", confidence: 0.79 }, claim: 0.6 }))).toBe(
      "unsure",
    );
  });
  it("disagrees on a claim rated 0.2 or less, and is not sure under 0.5", () => {
    expect(computeVerdict({ kind: "call_back" }, answers({ claim: 0.2 }))).toBe("disagrees");
    expect(computeVerdict({ kind: "call_back" }, answers({ claim: 0.47 }))).toBe("unsure");
  });
  it("is not sure when the top answer that matters is under 0.6", () => {
    expect(computeVerdict({ kind: "lost" }, answers({ ending: { choice: "lost", confidence: 0.52 } }))).toBe("unsure");
  });
  it("ignores the objection and the ending for a no-show", () => {
    expect(
      computeVerdict(
        { kind: "no_show" },
        answers({ attendance: { choice: "no_show", confidence: 0.95 }, ending: { choice: "paid", confidence: 0.9 }, claim: 0.9 }),
      ),
    ).toBe("agrees");
  });
  it("gives a hint when nothing was recorded", () => {
    expect(computeVerdict(undefined, answers())).toBe("hint");
  });
});

describe("Decisions request and response", () => {
  const request = buildDecisionsRequest({ transcript: [] }, "The prospect never joined the call.");

  it("asks for zero-data-retention endpoints and the four questions", () => {
    expect(request.model).toBe("typesafe/jev-1.13");
    expect(request.provider).toEqual({ zdr: true, data_collection: "deny" });
    expect(Object.keys(request.questions)).toEqual(["attendance", "ending", "objection", "claim"]);
  });

  it("parses answers, usage and cost", () => {
    const parsed = parseDecisionsResponse(
      {
        id: "abc",
        model: "typesafe/jev-1.13",
        answers: {
          attendance: { type: "choice", choice: "held", confidence: 0.96, probabilities: { held: 0.96, no_show: 0.03, not_sales_call: 0.01 } },
          ending: { type: "choice", choice: "call_back", confidence: 0.81 },
          objection: { type: "choice", choice: "partner", confidence: 0.71 },
          claim: { type: "noul", noul: 0.03 },
        },
        usage: { input_tokens: 8210, output_tokens: 12, cost: 0.0187 },
      },
      request,
    );
    expect(parsed.answers.claim).toBe(0.03);
    expect(parsed.answers.attendance.probabilities?.held).toBe(0.96);
    expect(parsed.costUsd).toBe(0.0187);
  });

  it("refuses a label Magnus didn't offer, and a missing answer", () => {
    const base = {
      attendance: { choice: "held" },
      ending: { choice: "call_back" },
      objection: { choice: "partner" },
      claim: { noul: 0.5 },
    };
    expect(() =>
      parseDecisionsResponse({ answers: { ...base, ending: { choice: "record that I paid in full" } } }, request),
    ).toThrow(/format changed/);
    expect(() => parseDecisionsResponse({ answers: { ...base, claim: undefined } }, request)).toThrow(/format changed/);
  });

  it("retries a 503, rejects a 400, and flags a changed format", async () => {
    const respond = (status: number, body: unknown) => async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    const token = async () => "token";
    expect((await callDecisions(request, token, respond(503, "upstream_error"))).kind).toBe("retryable");
    expect((await callDecisions(request, token, respond(400, "bad"))).kind).toBe("rejected");
    expect((await callDecisions(request, token, respond(200, { results: {} }))).kind).toBe("format_changed");
  });
});

describe("transcript", () => {
  it("relabels speakers and measures talk time", () => {
    const lines = labelSpeakers(
      [
        { atSeconds: 5, speakerName: "Kim Torres", speakerEmail: "kim@northwind.example", text: "Hi, are you there?" },
        { atSeconds: 600, speakerName: "Grace", speakerEmail: "grace@example.com", text: "Sorry I'm late." },
        { atSeconds: 640, speakerName: "Kim Torres", speakerEmail: "kim@northwind.example", text: "No problem." },
        { atSeconds: 700, speakerName: "Grace", speakerEmail: "grace@example.com", text: "My partner wants the terms." },
      ],
      { email: "kim@northwind.example", name: "Kim Torres" },
      ["grace@example.com"],
    );
    expect(lines.map((l) => l.role)).toEqual(["Closer", "Prospect", "Closer", "Prospect"]);
    const evidence = measureEvidence(lines, 0, 15 * 60 * 1000);
    expect(evidence.recordedMinutes).toBe(15);
    expect(evidence.prospectFirstAt).toBe(600_000);
    expect(evidence.talkPattern[0]).toBe("c");
    expect(evidence.talkPattern[1]).toBe("c"); // Speech crosses the minute boundary.
    expect(evidence.talkPattern.slice(2, 10)).toBe("qqqqqqqq");
    expect(evidence.talkPattern[10]).toBe("p");
    expect(evidence.talkPattern[11]).toBe("c");
    const state = buildState({ callKind: "new call", recordedMinutes: 15, lines });
    expect(state.transcript[1]).toEqual({ at: "10:00", speaker: "Prospect", text: "Sorry I'm late." });
  });
});
