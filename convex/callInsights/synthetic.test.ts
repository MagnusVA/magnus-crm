import { describe, expect, it } from "vitest";
import {
  EVIDENCE_FIXTURES,
  evidenceAnswer,
  evidenceStatement,
  INVITEES,
  NOW,
  RECORDER,
  SCHEDULED_AT,
  SYNTHETIC_FIXTURES,
} from "../../tests/callInsights/synthetic/fixtures";
import { parseStoredTranscript, prepareTranscript } from "./transcriptPrep";
import { parseExtraction } from "./parse";
import { validateEvidence, validateExtraction } from "./validate";
import { measureAttendance } from "./noShow/measures";
import { noShowTier } from "./noShow/tier";
import { deriveSuggestion } from "./suggest/derive";
import { flatAnswer } from "../../tests/callInsightsFlat";

const timeZone = "America/Tegucigalpa";
const evidenceTiming = {
  timeZone,
  callDateIso: "2026-11-10",
  callEndedAt: SCHEDULED_AT + 7 * 60_000,
};

describe("public-safe stored synthetic model answers", () => {
  it("keeps the twelve required scenarios", () =>
    expect(SYNTHETIC_FIXTURES).toHaveLength(12));
  for (const f of SYNTHETIC_FIXTURES)
    it(f.name, () => {
      const transcript = prepareTranscript(
        parseStoredTranscript(f.transcript),
        RECORDER,
        INVITEES,
      );
      const extract = (answer: unknown) =>
        validateExtraction(
          parseExtraction(JSON.stringify(answer)),
          transcript,
          { timeZone, now: NOW },
        );
      const extracted = extract(f.answer);
      const measures = measureAttendance({
        lines: transcript.lines,
        scheduledAt: SCHEDULED_AT,
        scheduledEndAt: SCHEDULED_AT + 30 * 60000,
        recordingStartAt: SCHEDULED_AT,
        recordingEndAt: SCHEDULED_AT + 7 * 60000,
        recorderIsAssignedCloser: true,
        matchStrong: true,
        otherRecordings: [],
        traceCoversWindow: true,
        newerBooking: false,
        inviteeEmails: INVITEES,
      });
      const decide = (value: typeof extracted) => {
        const noShow = noShowTier({
          eligible: true,
          now: NOW,
          measures,
          attendance: value.attendance,
          jev: f.reading.attendance,
          waitMinutes: 5,
        });
        return {
          noShow,
          suggestion: deriveSuggestion({
            noShow,
            result: value.result,
            attendance: value.attendance,
            reading: f.reading,
          }),
        };
      };
      const { noShow, suggestion } = decide(extracted);
      const evidence = evidenceAnswer({
        recordingScope: "whole",
        scopeLines: [1],
        statements: f.transcript
          .slice(0, 2)
          .map((line, index) =>
            evidenceStatement("defers", line.text, index + 1),
          ),
      });
      const p2 = extract({ ...f.answer, evidence });
      expect(JSON.stringify(p2)).toBe(JSON.stringify(extracted));
      expect(JSON.stringify(decide(p2))).toBe(
        JSON.stringify({ noShow, suggestion }),
      );
      expect(extracted.items).toHaveLength(f.expected.items.length);
      f.expected.items.forEach((item, index) =>
        expect(extracted.items[index]).toMatchObject(item),
      );
      expect(extracted.dropped).toEqual(f.expected.dropped);
      expect(noShow.tier).toBe(f.expected.noShowTier);
      if (f.expected.suggestion === null) expect(suggestion).toBeNull();
      else {
        expect(suggestion).toMatchObject(f.expected.suggestion);
        if (f.expected.suggestion.tier !== "ready")
          expect(suggestion?.values).toEqual({});
      }
      for (const code of f.expected.failedChecks ?? [])
        expect(extracted.result.failedChecks).toContain(code);
    });
});

describe("public-safe call evidence", () => {
  it.each(EVIDENCE_FIXTURES)("$name", (fixture) => {
    const transcript = prepareTranscript(
      parseStoredTranscript(fixture.transcript),
      RECORDER,
      INVITEES,
    );
    const readAt = fixture.readAt ?? NOW;
    const answer = flatAnswer(
      fixture.readAt !== undefined
        ? {
            result: {
              kind: "call_back",
              callbackDateTimeLocal: fixture.evidence.nextStepDateTimeLocal,
            },
          }
        : {},
    );
    const raw = parseExtraction(
      JSON.stringify({ ...answer, evidence: fixture.evidence }),
    );
    expect(raw.evidence).toBeDefined();
    expect(
      validateEvidence(raw.evidence!, transcript, evidenceTiming),
    ).toMatchObject(fixture.expected);
    if (fixture.readAt !== undefined)
      expect(
        validateExtraction(raw, transcript, { timeZone, now: readAt }).result
          .failedChecks,
      ).toContain("callback_not_future");
  });
});
