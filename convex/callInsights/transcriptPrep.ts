import { z } from "zod";
import {
  labelSpeakers,
  type TranscriptLine,
  type SpeakerRole,
} from "../secondOpinion/transcript";

export type PreparedLine = {
  index: number;
  atSeconds: number;
  at: string;
  role: SpeakerRole;
  speakerKey: string;
  isCloserKey: boolean;
  speakerEmail?: string;
  speakerName?: string;
  text: string;
};
export type PreparedTranscript = {
  lines: PreparedLine[];
  prospectWords: number;
  closerOnly: boolean;
  speakerUncertain: boolean;
  estimatedTokens: number;
};
export const MAX_TRANSCRIPT_TOKENS = 150_000;

const storedTranscript = z.array(
  z.object({
    speaker: z.string(),
    email: z.string().optional(),
    timestamp: z.string().regex(/^(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?$/),
    text: z.string(),
  }),
);

export function parseStoredTranscript(json: unknown): TranscriptLine[] {
  const result = storedTranscript.safeParse(json);
  if (!result.success)
    throw new Error("Stored transcript has an invalid shape");
  return result.data.map((line) => ({
    atSeconds: line.timestamp
      .split(":")
      .reduce((n, part) => n * 60 + Number(part), 0),
    speakerName: line.speaker,
    ...(line.email !== undefined ? { speakerEmail: line.email } : {}),
    text: line.text,
  }));
}

const key = (text: string | undefined) => text?.trim().toLowerCase() ?? "";
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

export function prepareTranscript(
  raw: TranscriptLine[],
  recorder: { email: string; names: string[] },
  inviteeEmails: string[],
): PreparedTranscript {
  const names = new Set(recorder.names.map(key).filter(Boolean));
  const isCloser = (line: TranscriptLine) =>
    (Boolean(key(recorder.email)) &&
      key(line.speakerEmail) === key(recorder.email)) ||
    (Boolean(key(line.speakerName)) && names.has(key(line.speakerName)));
  // Give the existing labeler every known recorder alias through its one-name interface.
  const labelled = labelSpeakers(
    raw.map((line) =>
      isCloser(line)
        ? {
            ...line,
            speakerName: recorder.names[0],
            speakerEmail: recorder.email,
          }
        : line,
    ),
    { email: recorder.email, name: recorder.names[0] },
    inviteeEmails,
  );
  const lines = raw.map(
    (line, i): PreparedLine => ({
      ...line,
      index: i + 1,
      at: clock(line.atSeconds),
      role: labelled[i].role,
      speakerKey: key(line.speakerEmail) || key(line.speakerName),
      isCloserKey: isCloser(line),
    }),
  );
  return {
    lines,
    prospectWords: lines.reduce(
      (n, line) =>
        n +
        (line.role === "Prospect"
          ? line.text.split(/\s+/).filter(Boolean).length
          : 0),
      0,
    ),
    closerOnly: lines.length > 0 && lines.every((line) => line.isCloserKey),
    speakerUncertain:
      !lines.some((line) => line.role === "Closer") ||
      new Set(
        lines
          .filter((line) => line.role === "Prospect")
          .map((line) => line.speakerKey),
      ).size >= 2,
    estimatedTokens: Math.ceil(renderLines(lines).length / 3.5),
  };
}

export function renderLines(lines: PreparedLine[]): string {
  return lines
    .map((line) => `#${line.index} [${line.at}] ${line.role[0]}: ${line.text}`)
    .join("\n");
}
export function linesAround(
  lines: PreparedLine[],
  lineIndex: number,
  radius: number,
): PreparedLine[] {
  return lines.filter((line) => Math.abs(line.index - lineIndex) <= radius);
}
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsCardNumber(text: string): boolean {
  const candidates = text.match(/\d(?:[ -]*\d){12,}/g) ?? [];
  return candidates.some((candidate) => {
    const groups = candidate.split(/[ -]+/);
    for (let start = 0; start < groups.length; start++) {
      let digits = "";
      for (let end = start; end < groups.length; end++) {
        digits += groups[end];
        if (digits.length > 19) break;
        if (digits.length < 13) continue;
        let sum = 0;
        for (let i = digits.length - 1; i >= 0; i--) {
          let n = Number(digits[i]);
          if ((digits.length - 1 - i) % 2 === 1) {
            n *= 2;
            if (n > 9) n -= 9;
          }
          sum += n;
        }
        if (sum % 10 === 0) return true;
      }
    }
    return false;
  });
}
