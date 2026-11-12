import { describe, expect, test } from "vitest";
import type {
  AttendanceEvidence,
  AttendanceMeasures,
  EarlyReading,
  FoundQuote,
} from "../validators";
import type { NoShowTier } from "../../../lib/callInsights/taxonomy";
import { measureAttendance } from "./measures";
import { NO_SHOW_NOTE_CODES, noShowTier, shadowTiers } from "./tier";

function quote(atSeconds: number): FoundQuote {
  return {
    quote: "Synthetic attendance evidence",
    lineIndex: 1,
    atSeconds,
    speaker: "Closer",
  };
}

function attendance(
  overrides: Partial<AttendanceEvidence> = {},
): AttendanceEvidence {
  return {
    reading: "absent",
    waiting: [quote(300)],
    leaving: [quote(590)],
    triedToReach: [],
    someoneThere: [],
    secondPerson: [],
    notSalesCall: [],
    ...overrides,
  };
}

function jev(
  choice = "no_show",
  confidence: number | undefined = 0.9,
): EarlyReading["attendance"] {
  return {
    withSummary: { choice, confidence },
    withoutSummary: { choice, confidence },
  };
}

function measures(
  overrides: Partial<AttendanceMeasures> = {},
): AttendanceMeasures {
  return {
    lineCount: 3,
    speakerKeys: 1,
    closerOnly: true,
    closerLines: 3,
    closerWordsAfterStart: 12,
    closerLinesAfterStart: 3,
    otherWords: 0,
    otherLines: 0,
    otherIsOneShortUnknown: false,
    answerLikePairs: 0,
    longestGapSeconds: 300,
    startOffsetSeconds: 0,
    endOffsetSeconds: 600,
    lengthSeconds: 600,
    recorderIsAssignedCloser: true,
    matchStrong: true,
    otherRecordingsWithLines: 0,
    otherRecordingsAny: 0,
    traceCoversWindow: true,
    newerBooking: false,
    slotEndedAt: 1_800_000,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<Parameters<typeof noShowTier>[0]> = {},
): Parameters<typeof noShowTier>[0] {
  return {
    eligible: true,
    now: 5_400_000,
    measures: measures(),
    attendance: attendance(),
    jev: jev(),
    waitMinutes: 10,
    ...overrides,
  };
}

describe("ordered no-show tiers", () => {
  test("eligibility precedes empty recording and all model evidence", () => {
    expect(
      noShowTier(
        candidate({ eligible: false, measures: measures({ lineCount: 0 }) }),
      ),
    ).toEqual({ tier: "none", notes: ["ineligible"] });
  });
  test("slot must be over, with equality allowed", () => {
    expect(noShowTier(candidate({ now: 1_799_999 })).tier).toBe("none");
    expect(noShowTier(candidate({ now: 1_800_000 })).tier).toBe("review");
  });
  test("verified not-sales-call quote wins even when Claude reads absent", () => {
    expect(
      noShowTier(
        candidate({ attendance: attendance({ notSalesCall: [quote(10)] }) }),
      ).tier,
    ).toBe("none");
  });
  test("an unsupported Claude not-sales-call reading alone does not exclude a proposed no-show", () => {
    expect(
      noShowTier(
        candidate({ attendance: attendance({ reading: "not_sales_call" }) }),
      ).tier,
    ).toBe("unconfirmed");
  });
  test.each(["withSummary", "withoutSummary"] as const)(
    "Jev not-sales-call in %s needs no confidence",
    (key) => {
      expect(
        noShowTier(
          candidate({ jev: { ...jev(), [key]: { choice: "not_sales_call" } } }),
        ).tier,
      ).toBe("none");
    },
  );
  test("empty recording needs five minutes from scheduled start, not recording length", () => {
    expect(
      noShowTier(
        candidate({
          attendance: undefined,
          jev: undefined,
          measures: measures({
            lineCount: 0,
            endOffsetSeconds: 300,
            lengthSeconds: 60,
          }),
        }),
      ).tier,
    ).toBe("empty");
    expect(
      noShowTier(
        candidate({
          attendance: undefined,
          jev: undefined,
          measures: measures({
            lineCount: 0,
            endOffsetSeconds: 299.999,
            lengthSeconds: 600,
          }),
        }),
      ).tier,
    ).toBe("none");
  });
  test("nobody proposing a no-show precedes contradictions", () => {
    expect(
      noShowTier(
        candidate({
          attendance: attendance({
            reading: "present",
            someoneThere: [quote(10)],
          }),
          jev: jev("held"),
          measures: measures({
            newerBooking: true,
            recorderIsAssignedCloser: false,
          }),
        }),
      ).tier,
    ).toBe("none");
  });
  test("all conditions met gives Certain", () => {
    expect(noShowTier(candidate())).toEqual({ tier: "certain", notes: [] });
  });
  test.each([
    [
      "someone_there",
      { attendance: attendance({ someoneThere: [quote(10)] }) },
    ],
    [
      "second_person",
      { attendance: attendance({ secondPerson: [quote(10)] }) },
    ],
    ["answer_like_pairs", { measures: measures({ answerLikePairs: 2 }) }],
    [
      "someone_spoke",
      {
        measures: measures({ closerOnly: false, otherLines: 1, otherWords: 1 }),
      },
    ],
    [
      "other_recording",
      {
        measures: measures({
          otherRecordingsWithLines: 1,
          otherRecordingsAny: 1,
        }),
      },
    ],
    ["newer_booking", { measures: measures({ newerBooking: true }) }],
    [
      "recorder_differs",
      { measures: measures({ recorderIsAssignedCloser: false }) },
    ],
  ] satisfies Array<[string, Partial<Parameters<typeof noShowTier>[0]>]>)(
    "Check on %s before Certain",
    (code, overrides) => {
      expect(noShowTier(candidate(overrides))).toEqual({
        tier: "check",
        notes: [code],
      });
    },
  );
  test.each(["withSummary", "withoutSummary"] as const)(
    "opposition in either Jev reading, %s, uses inclusive 0.60",
    (key) => {
      expect(
        noShowTier(
          candidate({
            jev: { ...jev(), [key]: { choice: "held", confidence: 0.6 } },
          }),
        ),
      ).toEqual({ tier: "check", notes: ["models_disagree"] });
      expect(
        noShowTier(
          candidate({
            jev: { ...jev(), [key]: { choice: "held", confidence: 0.5999 } },
          }),
        ).tier,
      ).toBe("unconfirmed");
    },
  );
  test("Claude present opposes Jev's no-show at 0.60", () => {
    expect(
      noShowTier(
        candidate({
          attendance: attendance({ reading: "present" }),
          jev: jev("no_show", 0.6),
        }),
      ).tier,
    ).toBe("check");
    expect(
      noShowTier(
        candidate({
          attendance: attendance({ reading: "present" }),
          jev: jev("no_show", 0.5999),
        }),
      ).tier,
    ).toBe("unconfirmed");
  });
  test("a Jev held answer opposes a no-show proposed by its other reading even when Claude is unclear", () => {
    expect(
      noShowTier(
        candidate({
          attendance: attendance({ reading: "unclear" }),
          jev: {
            withSummary: { choice: "no_show", confidence: 0.95 },
            withoutSummary: { choice: "held", confidence: 0.6 },
          },
        }),
      ),
    ).toEqual({ tier: "check", notes: ["models_disagree"] });
  });
  test.each([0.7999, 0.8, 0.8999, 0.9])(
    "uses the lower Jev confidence, %f",
    (confidence) => {
      const expected =
        confidence >= 0.9
          ? "certain"
          : confidence >= 0.8
            ? "review"
            : "unconfirmed";
      expect(
        noShowTier(
          candidate({
            jev: {
              withSummary: { choice: "no_show", confidence: 1 },
              withoutSummary: { choice: "no_show", confidence },
            },
          }),
        ).tier,
      ).toBe(expected);
    },
  );
  test.each([
    ["jev_missing", { jev: undefined }, "unconfirmed"],
    [
      "jev_missing",
      { jev: { withSummary: { choice: "no_show", confidence: 0.99 } } },
      "unconfirmed",
    ],
    [
      "jev_missing",
      {
        jev: {
          withSummary: { choice: "no_show" },
          withoutSummary: { choice: "no_show" },
        },
      },
      "unconfirmed",
    ],
    [
      "claude_not_absent",
      { attendance: attendance({ reading: "unclear" }) },
      "unconfirmed",
    ],
    ["claude_not_absent", { attendance: undefined }, "unconfirmed"],
    [
      "late_start",
      { measures: measures({ startOffsetSeconds: 180.001 }) },
      "review",
    ],
    [
      "long_recording",
      { measures: measures({ lengthSeconds: 5_400 }) },
      "review",
    ],
    [
      "too_many_words",
      { measures: measures({ closerWordsAfterStart: 251 }) },
      "review",
    ],
    [
      "too_many_lines",
      { measures: measures({ closerLinesAfterStart: 26 }) },
      "review",
    ],
    [
      "no_long_gap",
      { measures: measures({ longestGapSeconds: 119.999 }) },
      "review",
    ],
    ["weak_match", { measures: measures({ matchStrong: false }) }, "review"],
    [
      "other_recording",
      { measures: measures({ otherRecordingsAny: 1 }) },
      "review",
    ],
    [
      "trace_incomplete",
      { measures: measures({ traceCoversWindow: false }) },
      "review",
    ],
    ["no_waiting_quote", { attendance: attendance({ waiting: [] }) }, "review"],
    ["no_leaving_quote", { attendance: attendance({ leaving: [] }) }, "review"],
    ["slot_recently_ended", { now: 5_399_999 }, "review"],
    [
      "answer_like_pairs",
      { measures: measures({ answerLikePairs: 1 }) },
      "review",
    ],
    [
      "not_closer_only",
      {
        measures: measures({
          closerOnly: false,
          otherIsOneShortUnknown: true,
          otherLines: 3,
          otherWords: 15,
        }),
      },
      "review",
    ],
  ] satisfies Array<
    [string, Partial<Parameters<typeof noShowTier>[0]>, NoShowTier]
  >)("%s gives %s", (code, overrides, tier) => {
    const actual = noShowTier(candidate(overrides));
    expect(actual.tier).toBe(tier);
    expect(actual.notes).toContain(code);
    expect(
      actual.notes.every((note) =>
        NO_SHOW_NOTE_CODES.some((known) => known === note),
      ),
    ).toBe(true);
  });
  test("inclusive Certain boundaries: +3:00, 250 words, 25 lines, two-minute gap, one hour after slot", () => {
    expect(
      noShowTier(
        candidate({
          measures: measures({
            startOffsetSeconds: 180,
            closerWordsAfterStart: 250,
            closerLinesAfterStart: 25,
            longestGapSeconds: 120,
            lengthSeconds: 5_399.999,
          }),
          attendance: attendance({ leaving: [quote(5_399.999)] }),
        }),
      ).tier,
    ).toBe("certain");
  });
  test("waiting uses scheduled start and includes exactly +5:00", () => {
    const m = measures({ startOffsetSeconds: -60 });
    expect(
      noShowTier(
        candidate({
          measures: m,
          attendance: attendance({ waiting: [quote(360)] }),
        }),
      ).tier,
    ).toBe("certain");
    expect(
      noShowTier(
        candidate({
          measures: m,
          attendance: attendance({ waiting: [quote(359.999)] }),
        }),
      ).notes,
    ).toContain("no_waiting_quote");
  });
  test("leaving includes exactly the last 120 seconds and rejects earlier or post-recording quotes", () => {
    expect(
      noShowTier(
        candidate({ attendance: attendance({ leaving: [quote(480)] }) }),
      ).tier,
    ).toBe("certain");
    for (const at of [479.999, 600.001]) {
      expect(
        noShowTier(
          candidate({ attendance: attendance({ leaving: [quote(at)] }) }),
        ).notes,
      ).toContain("no_leaving_quote");
    }
  });
  test.each([5, 7, 10])(
    "wait %i is measured from scheduled start and includes equality",
    (waitMinutes) => {
      const end = waitMinutes * 60;
      const args = candidate({
        waitMinutes,
        measures: measures({ endOffsetSeconds: end, lengthSeconds: end }),
        attendance: attendance({ leaving: [quote(end)] }),
      });
      expect(noShowTier(args).tier).toBe("certain");
      expect(
        noShowTier({
          ...args,
          measures: { ...args.measures, endOffsetSeconds: end - 0.001 },
        }).notes,
      ).toContain("wait_not_met");
    },
  );
  test("an unset wait prevents Certain and shadow waits remain independent", () => {
    expect(noShowTier(candidate({ waitMinutes: undefined }))).toEqual({
      tier: "review",
      notes: ["wait_unset"],
    });
    const args = candidate({
      measures: measures({ endOffsetSeconds: 420, lengthSeconds: 420 }),
      attendance: attendance({ leaving: [quote(420)] }),
    });
    expect(shadowTiers(args)).toEqual({
      wait5: "certain",
      wait7: "certain",
      wait10: "review",
    });
    expect(args.waitMinutes).toBe(10);
  });
  test("a split with no strong opposing held answer stays Unconfirmed", () => {
    expect(
      noShowTier(
        candidate({
          jev: {
            withSummary: { choice: "no_show", confidence: 0.95 },
            withoutSummary: { choice: "held", confidence: 0.59 },
          },
        }),
      ).tier,
    ).toBe("unconfirmed");
  });
});

describe("spec section 2.7 edge cases", () => {
  test.each([
    [
      "Prospect muted, typed chat",
      {
        attendance: attendance({ someoneThere: [quote(30)] }),
        measures: measures({ closerWordsAfterStart: 300 }),
      },
      "check",
    ],
    [
      "Same room, one microphone",
      { measures: measures({ answerLikePairs: 2 }) },
      "check",
    ],
    [
      "Closer phones prospect on speaker",
      { jev: jev("held"), measures: measures({ closerWordsAfterStart: 500 }) },
      "check",
    ],
    [
      "Spouse/assistant stand-in",
      {
        measures: measures({
          closerOnly: false,
          otherLines: 4,
          otherWords: 16,
        }),
      },
      "check",
    ],
    [
      "Prospect joined without audio",
      {
        attendance: attendance({
          someoneThere: [quote(50)],
          suggestedReason: "technical_issues",
        }),
      },
      "check",
    ],
    ["Prospect arrives after recording stops", {}, "certain"],
    [
      "Recorder got wrong meeting",
      { measures: measures({ matchStrong: false }) },
      "review",
    ],
    [
      "Zero lines",
      {
        measures: measures({ lineCount: 0 }),
        attendance: undefined,
        jev: undefined,
      },
      "empty",
    ],
    [
      "Closer leaves recorder on, talks with colleague",
      { attendance: attendance({ notSalesCall: [quote(10)] }) },
      "none",
    ],
    [
      "Recording >2 hours, Jev sees only last hour",
      { measures: measures({ lengthSeconds: 7_740 }) },
      "review",
    ],
  ] satisfies Array<
    [string, Partial<Parameters<typeof noShowTier>[0]>, NoShowTier]
  >)("%s", (_name, overrides, tier) => {
    expect(noShowTier(candidate(overrides)).tier).toBe(tier);
  });
  test.each(["muted", "same room", "speakerphone", "stand-in", "no audio"])(
    "%s stays None if both models read present, despite contradictions",
    () => {
      expect(
        noShowTier(
          candidate({
            attendance: attendance({
              reading: "present",
              someoneThere: [quote(30)],
              secondPerson: [quote(35)],
            }),
            jev: jev("held"),
            measures: measures({
              otherLines: 20,
              otherWords: 300,
              answerLikePairs: 4,
            }),
          }),
        ).tier,
      ).toBe("none");
    },
  );
  test("a colleague conversation becomes Check when absent is proposed without a verified exclusion", () => {
    expect(
      noShowTier(
        candidate({
          measures: measures({ otherLines: 10, closerOnly: false }),
        }),
      ).tier,
    ).toBe("check");
  });
});

describe("production examples A to I, represented by synthetic lines", () => {
  test.each([
    ["A", 5.3, "absent", 1, 3, "review"],
    ["B", 8.6, "absent", 1, 3, "review"],
    ["C", 5.1, "absent", 1, 3, "review"],
    ["D", 17.7, "absent", 1, 3, "review"],
    ["E", 5.1, "absent", 0, 0, "empty"],
    ["F", 7.2, "absent", 0, 0, "empty"],
    ["G", 129, "present", 1_516, 3, "none"],
    ["H", 0.9, "present", 1, 11, "none"],
    ["I", 1.7, "present", 1, 6, "none"],
  ] satisfies Array<
    [string, number, "absent" | "present", number, number, NoShowTier]
  >)("example %s", (name, minutes, reading, count, wordCount, tier) => {
    const knownProspect = name === "H" || name === "I";
    const m = measureAttendance({
      lines: Array.from({ length: count }, (_, index) => ({
        index: index + 1,
        atSeconds: (index * minutes * 60) / Math.max(count, 1),
        at: "00:00",
        role: "Closer",
        isCloserKey: !knownProspect,
        speakerKey: knownProspect
          ? "prospect@example.test"
          : "closer@example.test",
        speakerEmail: knownProspect
          ? "prospect@example.test"
          : "closer@example.test",
        text: Array.from({ length: wordCount }, () => "synthetic").join(" "),
      })),
      scheduledAt: 0,
      scheduledEndAt: 1_800_000,
      recordingStartAt: 0,
      recordingEndAt: minutes * 60_000,
      recorderIsAssignedCloser: true,
      matchStrong: true,
      otherRecordings: [],
      traceCoversWindow: true,
      newerBooking: false,
      inviteeEmails: ["prospect@example.test"],
    });
    const evidence = attendance({
      reading,
      leaving: [],
      ...(name === "D" ? { suggestedReason: "technical_issues" } : {}),
    });
    const args = candidate({
      measures: m,
      attendance: count ? evidence : undefined,
      jev: count ? jev(reading === "present" ? "held" : "no_show") : undefined,
    });
    expect(noShowTier(args).tier).toBe(tier);
    if (name === "D")
      expect(
        noShowTier({ ...args, measures: { ...m, newerBooking: true } }).tier,
      ).toBe("check");
  });
});
