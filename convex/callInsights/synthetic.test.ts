import { describe, expect, it } from "vitest";
import {
  INVITEES,
  NOW,
  RECORDER,
  SCHEDULED_AT,
  SYNTHETIC_FIXTURES,
} from "../../tests/callInsights/synthetic/fixtures";
import { parseStoredTranscript, prepareTranscript } from "./transcriptPrep";
import { parseExtraction } from "./parse";
import { validateExtraction } from "./validate";
import { measureAttendance } from "./noShow/measures";
import { noShowTier } from "./noShow/tier";
import { deriveSuggestion } from "./suggest/derive";

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
      const extracted = validateExtraction(
        parseExtraction(JSON.stringify(f.answer)),
        transcript,
        { timeZone: "America/Tegucigalpa", now: NOW },
      );
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
      const noShow = noShowTier({
        eligible: true,
        now: NOW,
        measures,
        attendance: extracted.attendance,
        jev: f.reading.attendance,
        waitMinutes: 5,
      });
      const suggestion = deriveSuggestion({
        noShow,
        result: extracted.result,
        attendance: extracted.attendance,
        reading: f.reading,
      });
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
