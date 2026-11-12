import type { PreparedLine } from "../transcriptPrep";
import type { AttendanceMeasures } from "../validators";

const SHORT_ANSWERS = new Set([
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
]);

function words(text: string): number {
  return text.match(/\S+/gu)?.length ?? 0;
}

export function measureAttendance(a: {
  lines: PreparedLine[];
  scheduledAt: number;
  scheduledEndAt: number;
  recordingStartAt: number;
  recordingEndAt: number;
  recorderIsAssignedCloser: boolean;
  matchStrong: boolean;
  otherRecordings: Array<{ hasLines: boolean }>;
  traceCoversWindow: boolean;
  newerBooking: boolean;
  inviteeEmails: string[];
}): AttendanceMeasures {
  const lines = [...a.lines].sort(
    (left, right) => left.atSeconds - right.atSeconds,
  );
  const startOffsetSeconds = (a.recordingStartAt - a.scheduledAt) / 1_000;
  const endOffsetSeconds = (a.recordingEndAt - a.scheduledAt) / 1_000;
  const lengthSeconds = (a.recordingEndAt - a.recordingStartAt) / 1_000;
  const invitees = new Set(
    a.inviteeEmails.map((email) => email.trim().toLowerCase()),
  );
  const closer = lines.filter((line) => line.isCloserKey);
  const afterStart = closer.filter(
    (line) => line.atSeconds + startOffsetSeconds >= 0,
  );
  const other = lines.filter((line) => !line.isCloserKey);
  const otherKeys = new Set(other.map((line) => line.speakerKey));
  const otherWords = other.reduce((sum, line) => sum + words(line.text), 0);
  const speakerKeys = new Set(lines.map((line) => line.speakerKey)).size;
  // Fathom lists the closer among the invitees too, so an invitee's line only
  // marks the prospect's arrival when it isn't the closer speaking.
  const prospectFirst = lines.find(
    (line) =>
      !line.isCloserKey &&
      line.speakerEmail &&
      invitees.has(line.speakerEmail.trim().toLowerCase()),
  );
  let answerLikePairs = 0;
  let longestGapSeconds = 0;
  let previousStart = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    longestGapSeconds = Math.max(
      longestGapSeconds,
      line.atSeconds - previousStart,
    );
    previousStart = line.atSeconds;
    const next = lines[index + 1];
    if (
      !line.isCloserKey ||
      !line.text.trimEnd().endsWith("?") ||
      !next?.isCloserKey
    )
      continue;
    // "yeah yeah" or "okay sure" answer a question as much as a single "yes" does.
    const answer = next.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (
      next.atSeconds - line.atSeconds <= 5 &&
      answer.length > 0 &&
      answer.length <= 3 &&
      answer.every((word) => SHORT_ANSWERS.has(word))
    ) {
      answerLikePairs++;
    }
  }
  longestGapSeconds = Math.max(
    longestGapSeconds,
    lengthSeconds - previousStart,
  );

  return {
    lineCount: lines.length,
    speakerKeys,
    // Fathom sometimes gives the recorder an email on some lines and only a
    // name on others. Both are the closer, so two closer keys are still one voice.
    closerOnly: lines.length > 0 && other.length === 0,
    closerLines: closer.length,
    closerWordsAfterStart: afterStart.reduce(
      (sum, line) => sum + words(line.text),
      0,
    ),
    closerLinesAfterStart: afterStart.length,
    otherWords,
    otherLines: other.length,
    otherIsOneShortUnknown:
      otherKeys.size === 1 &&
      otherWords <= 15 &&
      other.length <= 3 &&
      other.every(
        (line) =>
          !line.speakerEmail &&
          !invitees.has(line.speakerKey.trim().toLowerCase()),
      ),
    answerLikePairs,
    longestGapSeconds,
    startOffsetSeconds,
    endOffsetSeconds,
    lengthSeconds,
    recorderIsAssignedCloser: a.recorderIsAssignedCloser,
    matchStrong: a.matchStrong,
    otherRecordingsWithLines: a.otherRecordings.filter(
      (recording) => recording.hasLines,
    ).length,
    otherRecordingsAny: a.otherRecordings.length,
    traceCoversWindow: a.traceCoversWindow,
    newerBooking: a.newerBooking,
    slotEndedAt: a.scheduledEndAt,
    ...(prospectFirst
      ? {
          prospectFirstLineOffsetSeconds:
            startOffsetSeconds + prospectFirst.atSeconds,
        }
      : {}),
    ...(other[0]
      ? { firstOtherLineOffsetSeconds: startOffsetSeconds + other[0].atSeconds }
      : {}),
  };
}
