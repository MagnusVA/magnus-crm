import { describe, expect, test } from "vitest";
import type { PreparedLine } from "../transcriptPrep";
import { measureAttendance } from "./measures";

function line(overrides: Partial<PreparedLine> = {}): PreparedLine {
  return {
    index: 1,
    atSeconds: 0,
    at: "00:00",
    role: "Closer",
    speakerKey: "closer@example.test",
    isCloserKey: true,
    speakerEmail: "closer@example.test",
    text: "Still waiting here.",
    ...overrides,
  };
}

function measure(
  lines: PreparedLine[],
  overrides: Partial<Parameters<typeof measureAttendance>[0]> = {},
) {
  return measureAttendance({
    lines,
    scheduledAt: 1_000_000,
    scheduledEndAt: 2_800_000,
    recordingStartAt: 1_000_000,
    recordingEndAt: 1_600_000,
    recorderIsAssignedCloser: true,
    matchStrong: true,
    otherRecordings: [],
    traceCoversWindow: true,
    newerBooking: false,
    inviteeEmails: ["prospect@example.test"],
    ...overrides,
  });
}

describe("measureAttendance", () => {
  test("measures empty recordings without inventing a closer or a first line", () => {
    const actual = measure([]);
    expect(actual).toMatchObject({
      lineCount: 0,
      speakerKeys: 0,
      closerOnly: false,
      closerLines: 0,
      closerWordsAfterStart: 0,
      closerLinesAfterStart: 0,
      otherWords: 0,
      otherLines: 0,
      otherIsOneShortUnknown: false,
      answerLikePairs: 0,
      longestGapSeconds: 600,
      startOffsetSeconds: 0,
      endOffsetSeconds: 600,
      lengthSeconds: 600,
      recorderIsAssignedCloser: true,
      matchStrong: true,
      otherRecordingsWithLines: 0,
      otherRecordingsAny: 0,
      traceCoversWindow: true,
      newerBooking: false,
      slotEndedAt: 2_800_000,
    });
    expect(actual).not.toHaveProperty("prospectFirstLineOffsetSeconds");
    expect(actual).not.toHaveProperty("firstOtherLineOffsetSeconds");
  });

  test("uses precomputed keys rather than fallback speaker roles", () => {
    const actual = measure([
      line({ role: "Prospect" }),
      line({
        index: 2,
        atSeconds: 20,
        role: "Closer",
        isCloserKey: false,
        speakerKey: "guest",
        speakerEmail: undefined,
        text: "Hello there",
      }),
    ]);
    expect(actual).toMatchObject({
      closerOnly: false,
      speakerKeys: 2,
      closerLines: 1,
      otherLines: 1,
      otherWords: 2,
      otherIsOneShortUnknown: true,
    });
  });

  test("closer-only requires one distinct key even when multiple keys belong to the closer", () => {
    expect(measure([line()]).closerOnly).toBe(true);
    // The closer under two of their own keys (email on one line, name on another) is still alone.
    expect(
      measure([line(), line({ speakerKey: "closer name" })]).closerOnly,
    ).toBe(true);
    expect(
      measure([
        line(),
        line({ speakerKey: "someone else", isCloserKey: false }),
      ]).closerOnly,
    ).toBe(false);
  });

  test("uses scheduled-start offsets and includes lines exactly at scheduled start", () => {
    const actual = measure(
      [
        line({ atSeconds: 30, text: "Before the slot" }),
        line({ index: 2, atSeconds: 60, text: "At start" }),
        line({ index: 3, atSeconds: 61, text: "After the start" }),
      ],
      { recordingStartAt: 940_000 },
    );
    expect(actual).toMatchObject({
      startOffsetSeconds: -60,
      endOffsetSeconds: 600,
      lengthSeconds: 660,
      closerWordsAfterStart: 5,
      closerLinesAfterStart: 2,
    });
  });

  test("finds first other and first email-proven prospect independently in chronological order", () => {
    const actual = measure(
      [
        line({
          atSeconds: 90,
          speakerEmail: "PROSPECT@EXAMPLE.TEST",
          speakerKey: "prospect@example.test",
          isCloserKey: false,
        }),
        line({
          atSeconds: 10,
          speakerEmail: undefined,
          speakerKey: "guest",
          isCloserKey: false,
        }),
        line({ atSeconds: 80, role: "Prospect" }),
      ],
      { recordingStartAt: 940_000 },
    );
    expect(actual).toMatchObject({
      prospectFirstLineOffsetSeconds: 30,
      firstOtherLineOffsetSeconds: -50,
      otherIsOneShortUnknown: false,
    });
  });

  test.each([
    ["recording start", [180, 240], 400, 180],
    ["between starts", [10, 250, 300], 400, 240],
    ["recording end", [10, 20], 400, 380],
    ["exactly two minutes", [120, 240], 360, 120],
  ] as const)(
    "includes %s in the longest gap",
    (_name, starts, end, expected) => {
      const lines = starts.map((atSeconds, index) =>
        line({ index: index + 1, atSeconds }),
      );
      expect(
        measure(lines, { recordingEndAt: 1_000_000 + end * 1_000 })
          .longestGapSeconds,
      ).toBe(expected);
    },
  );

  test.each([
    "yes",
    "yeah",
    "yep",
    "okay",
    "ok",
    "right",
    "sure",
    "sí",
    "si",
    "claro",
    "exacto",
  ])("recognizes the short answer %s at exactly five seconds", (answer) => {
    expect(
      measure([
        line({ text: "Are you there?" }),
        line({ atSeconds: 5, text: ` ${answer.toUpperCase()}! ` }),
      ]).answerLikePairs,
    ).toBe(1);
  });

  test.each([
    ["late answer", { atSeconds: 5.001, text: "yes" }],
    ["another speaker", { atSeconds: 5, text: "yes", isCloserKey: false }],
    ["long answer", { atSeconds: 5, text: "yes that is correct" }],
    ["unlisted answer", { atSeconds: 5, text: "perhaps" }],
  ] satisfies Array<[string, Partial<PreparedLine>]>)(
    "rejects %s",
    (_name, answer) => {
      expect(
        measure([line({ text: "Are you there?" }), line(answer)])
          .answerLikePairs,
      ).toBe(0);
    },
  );

  test("requires an adjacent question and counts each pair once", () => {
    expect(
      measure([
        line({ text: "There you are." }),
        line({ atSeconds: 1, text: "yes" }),
        line({ atSeconds: 2, text: "Ready?" }),
        line({ atSeconds: 3, text: "Okay." }),
        line({ atSeconds: 4, text: "Sure?" }),
        line({ atSeconds: 5, text: "Sí!" }),
      ]).answerLikePairs,
    ).toBe(2);
  });

  test.each([
    [15, 3, true],
    [16, 3, false],
    [15, 4, false],
    [14, 2, true],
  ])(
    "one unknown speaker with %i words in %i lines is allowed: %s",
    (wordCount, lineCount, expected) => {
      const lines = Array.from({ length: lineCount }, (_, index) =>
        line({
          index: index + 1,
          atSeconds: index,
          isCloserKey: false,
          speakerKey: "guest",
          speakerEmail: undefined,
          text: Array.from(
            {
              length:
                Math.floor(wordCount / lineCount) +
                (index < wordCount % lineCount ? 1 : 0),
            },
            () => "word",
          ).join(" "),
        }),
      );
      expect(measure(lines).otherIsOneShortUnknown).toBe(expected);
    },
  );

  test("rejects multiple unknown keys, known emails, and invitee email keys", () => {
    const guest = line({
      isCloserKey: false,
      speakerKey: "guest",
      speakerEmail: undefined,
    });
    expect(
      measure([guest, { ...guest, speakerKey: "another" }])
        .otherIsOneShortUnknown,
    ).toBe(false);
    expect(
      measure([{ ...guest, speakerEmail: "staff@example.test" }])
        .otherIsOneShortUnknown,
    ).toBe(false);
    expect(
      measure([{ ...guest, speakerKey: "prospect@example.test" }])
        .otherIsOneShortUnknown,
    ).toBe(false);
  });

  test("carries caller-proven context and counts every other recording", () => {
    expect(
      measure([line()], {
        recorderIsAssignedCloser: false,
        matchStrong: false,
        newerBooking: true,
        traceCoversWindow: false,
        otherRecordings: [
          { hasLines: true },
          { hasLines: false },
          { hasLines: true },
        ],
      }),
    ).toMatchObject({
      recorderIsAssignedCloser: false,
      matchStrong: false,
      newerBooking: true,
      traceCoversWindow: false,
      otherRecordingsWithLines: 2,
      otherRecordingsAny: 3,
    });
  });

  test("does not mutate transcript order or input lines", () => {
    const lines = [line({ atSeconds: 20 }), line({ atSeconds: 10 })];
    const before = structuredClone(lines);
    measure(lines);
    expect(lines).toEqual(before);
  });
  test("never takes the closer's own line for the prospect's arrival", () => {
    // Fathom lists the host among the calendar invitees too.
    const actual = measure(
      [
        line({ atSeconds: 5 }),
        line({
          index: 2,
          atSeconds: 720,
          role: "Prospect",
          speakerKey: "prospect@example.test",
          isCloserKey: false,
          speakerEmail: "prospect@example.test",
          text: "Sorry I'm late.",
        }),
      ],
      { inviteeEmails: ["closer@example.test", "prospect@example.test"] },
    );
    expect(actual.prospectFirstLineOffsetSeconds).toBe(720);
  });
});
