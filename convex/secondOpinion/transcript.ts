/**
 * Prepares a recording for Jev and measures the evidence Magnus shows beside
 * its answer (docs/plans/closer-assistant.md §6.9). Speakers become Closer
 * and Prospect before anything leaves Magnus, so Jev knows whose voice is
 * whose; names spoken aloud stay in the words. Talk time is measured from
 * the timestamps here, not by a model.
 */
export type TranscriptLine = {
  /** Seconds from the recording's start. */
  atSeconds: number;
  speakerName?: string;
  speakerEmail?: string;
  text: string;
};

export type SpeakerRole = "Closer" | "Prospect" | "Other";

export type LabelledLine = { at: string; speaker: SpeakerRole; text: string };

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/**
 * The recorder is the Closer. A speaker whose email is an invitee's is the
 * Prospect. Otherwise a speaker named like the recorder is the Closer, and
 * anyone else is Other.
 */
export function labelSpeakers(
  lines: TranscriptLine[],
  recorder: { email: string; name?: string },
  inviteeEmails: string[],
): Array<TranscriptLine & { role: SpeakerRole }> {
  const recorderEmail = recorder.email.toLowerCase();
  const invitees = new Set(inviteeEmails.map((email) => email.toLowerCase()));
  const recorderName = recorder.name?.trim().toLowerCase();
  const roleOf = (line: TranscriptLine): SpeakerRole | null => {
    const email = line.speakerEmail?.toLowerCase();
    if (email && email === recorderEmail) return "Closer";
    if (email && invitees.has(email)) return "Prospect";
    if (recorderName && line.speakerName?.trim().toLowerCase() === recorderName)
      return "Closer";
    return null;
  };
  return lines.map((line) => ({
    ...line,
    role: roleOf(line) ?? "Other",
  }));
}

export type Evidence = {
  recordedMinutes: number;
  closerMinutes: number;
  prospectMinutes: number;
  prospectFirstAt?: number;
  talkPattern: string;
};

/**
 * Minutes each side spoke, from each line's start to the next line's start
 * (capped at 60 seconds a line), and one letter per minute for the strip:
 * c closer, p prospect, q silence.
 */
export function measureEvidence(
  lines: Array<{ atSeconds: number; role: SpeakerRole }>,
  recordingStartAt: number,
  recordingEndAt: number,
): Evidence {
  const totalSeconds = Math.max(0, (recordingEndAt - recordingStartAt) / 1000);
  const minutes = Math.max(1, Math.ceil(totalSeconds / 60));
  const perMinute = Array.from({ length: minutes }, () => ({ c: 0, p: 0 }));
  let closer = 0;
  let prospect = 0;
  let prospectFirst: number | undefined;
  const sorted = [...lines].sort((a, b) => a.atSeconds - b.atSeconds);
  sorted.forEach((line, i) => {
    const next =
      sorted[i + 1]?.atSeconds ?? Math.min(line.atSeconds + 10, totalSeconds);
    const start = Math.max(0, line.atSeconds);
    const span = Math.max(0, Math.min(next - start, 60, totalSeconds - start));
    const addMinutes = (role: "c" | "p") => {
      const end = start + span;
      for (let at = start; at < end;) {
        const minute = Math.floor(at / 60);
        const until = Math.min(end, (minute + 1) * 60);
        perMinute[minute][role] += until - at;
        at = until;
      }
    };
    if (line.role === "Closer") {
      closer += span;
      addMinutes("c");
    } else if (line.role === "Prospect") {
      prospect += span;
      addMinutes("p");
      if (span > 0) prospectFirst ??= recordingStartAt + start * 1000;
    }
  });
  const talkPattern = perMinute
    .map(({ c, p }) => (c + p < 5 ? "q" : p > c ? "p" : "c"))
    .join("")
    .slice(0, 240);
  return {
    recordedMinutes: Math.round(totalSeconds / 60),
    closerMinutes: Math.round(closer / 60),
    prospectMinutes: Math.round(prospect / 60),
    ...(prospectFirst !== undefined ? { prospectFirstAt: prospectFirst } : {}),
    talkPattern,
  };
}

const TWO_HOURS_SECONDS = 2 * 60 * 60;
const LAST_HOUR_SECONDS = 60 * 60;

/**
 * The `state` Jev reads: the call's facts, Fathom's summary and action items,
 * and the labelled transcript. A call over two hours sends the summary and
 * its last hour (decision 31).
 */
export function buildState(input: {
  callKind: "new call" | "follow-up call";
  program?: string;
  recordedMinutes: number;
  summary?: string;
  actionItems?: string[];
  lines: Array<TranscriptLine & { role: SpeakerRole }>;
}) {
  const last = input.recordedMinutes * 60;
  const trimmed = last > TWO_HOURS_SECONDS;
  const from = trimmed ? last - LAST_HOUR_SECONDS : 0;
  return {
    call: {
      kind: input.callKind,
      ...(input.program ? { program: input.program } : {}),
      minutes: input.recordedMinutes,
      ...(trimmed ? { transcriptCoversLastMinutes: 60 } : {}),
    },
    ...(input.summary ? { fathomSummary: input.summary } : {}),
    ...(input.actionItems?.length ? { actionItems: input.actionItems } : {}),
    transcript: input.lines
      .filter((line) => line.atSeconds >= from)
      .map((line): LabelledLine => ({
        at: clock(line.atSeconds),
        speaker: line.role,
        text: line.text,
      })),
  };
}
