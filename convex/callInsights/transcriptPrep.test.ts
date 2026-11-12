import { describe, expect, test } from "vitest";
import {
  containsCardNumber,
  linesAround,
  normalizeForMatch,
  parseStoredTranscript,
  prepareTranscript,
  renderLines,
} from "./transcriptPrep";

const recorder = {
  email: "closer@example.test",
  names: ["Magnus Name", "Fathom Name"],
};
describe("stored transcripts and speakers", () => {
  test("reads the stored shape and fractional clocks", () => {
    const raw = parseStoredTranscript([
      {
        speaker: "Magnus Name",
        email: recorder.email,
        timestamp: "1:02:03.5",
        text: "Hello",
      },
    ]);
    expect(raw[0]).toMatchObject({
      atSeconds: 3723.5,
      speakerName: "Magnus Name",
    });
    expect(renderLines(prepareTranscript(raw, recorder, []).lines)).toBe(
      "#1 [1:02:03] C: Hello",
    );
  });
  test.each([
    null,
    {},
    [{ speaker: "x", timestamp: "bad", text: "private" }],
    [{ timestamp: "00:01", text: "x" }],
  ])("rejects bad storage without including its contents", (value) => {
    expect(() => parseStoredTranscript(value)).toThrow(
      "Stored transcript has an invalid shape",
    );
    try {
      parseStoredTranscript(value);
    } catch (error) {
      expect(String(error)).not.toContain("private");
    }
  });
  test("recognizes both recorder names, email keys and numbered context", () => {
    const t = prepareTranscript(
      [
        { atSeconds: 0, speakerName: " fathom NAME ", text: "Hello" },
        {
          atSeconds: 4,
          speakerEmail: "PROSPECT@example.test",
          text: "Two words",
        },
        { atSeconds: 8, speakerName: "Magnus Name", text: "Hi" },
      ],
      recorder,
      ["prospect@example.test"],
    );
    expect(
      t.lines.map((line) => [
        line.index,
        line.role,
        line.isCloserKey,
        line.speakerKey,
      ]),
    ).toEqual([
      [1, "Closer", true, "fathom name"],
      [2, "Prospect", false, "prospect@example.test"],
      [3, "Closer", true, "magnus name"],
    ]);
    expect(t).toMatchObject({
      prospectWords: 2,
      closerOnly: false,
      speakerUncertain: false,
    });
    expect(t.estimatedTokens).toBe(
      Math.ceil(renderLines(t.lines).length / 3.5),
    );
    expect(linesAround(t.lines, 2, 1)).toHaveLength(3);
    expect(linesAround(t.lines, 1, 0)).toEqual([t.lines[0]]);
  });
  test("only closer lines qualifies, empty recording does not", () => {
    expect(
      prepareTranscript(
        [{ atSeconds: 0, speakerEmail: recorder.email, text: "Waiting" }],
        recorder,
        [],
      ).closerOnly,
    ).toBe(true);
    expect(prepareTranscript([], recorder, []).closerOnly).toBe(false);
  });
  test("no closer and multiple fallback prospect keys are uncertain", () => {
    expect(
      prepareTranscript(
        [{ atSeconds: 0, speakerName: "Person", text: "Hi" }],
        recorder,
        [],
      ).speakerUncertain,
    ).toBe(true);
    const t = prepareTranscript(
      [
        { atSeconds: 0, speakerEmail: recorder.email, text: "Hi" },
        { atSeconds: 1, speakerName: "Person", text: "Hi" },
        { atSeconds: 2, speakerName: "Friend", text: "Hi" },
      ],
      recorder,
      [],
    );
    expect(t.speakerUncertain).toBe(true);
    expect(
      prepareTranscript(t.lines.slice(0, 2), recorder, []).speakerUncertain,
    ).toBe(false);
  });
  test("other email is Other when invitee is known", () => {
    const t = prepareTranscript(
      [
        { atSeconds: 0, speakerEmail: recorder.email, text: "Hi" },
        { atSeconds: 1, speakerEmail: "p@example.test", text: "Hi" },
        { atSeconds: 2, speakerEmail: "other@example.test", text: "Hi" },
      ],
      recorder,
      ["p@example.test"],
    );
    expect(t.lines[2].role).toBe("Other");
    expect(t.speakerUncertain).toBe(false);
  });
});
test("normalizes accents, case, punctuation and whitespace", () => {
  expect(normalizeForMatch("  ¡SÍ,\n CLARO!  ")).toBe("si claro");
  expect(normalizeForMatch("I can't earn 6,000.")).toBe("i cant earn 6000");
});
test.each([
  ["Card 4111 1111 1111 1111", true],
  ["Card 4111-1111-1111-1111", true],
  ["Card 378282246310005", true],
  ["4111 1111 1111 1112", false],
  ["123456789012", false],
  ["Card 4111 1111 1111 1111 5000", true],
  ["12345678901234567890", false],
  ["I make 6000", false],
])("card check for %s", (text, expected) =>
  expect(containsCardNumber(text)).toBe(expected),
);
