import type { CallRecord } from "./questions";

/**
 * Turns Jev's answers into Agrees, Not sure or Disagrees, in plain code
 * (docs/plans/closer-assistant.md §6.9, decision 32). Tuned after the
 * shadow run; every threshold lives here.
 */
export const VERDICT_THRESHOLDS = {
  /** Jev's top answer contradicts the record at this confidence or more. */
  disagreeConfidence: 0.8,
  /** The claim rates this or less. */
  disagreeClaim: 0.2,
  /** Below this, the answer that matters is Not sure. */
  unsureConfidence: 0.6,
  /** A claim between disagreeClaim and this is Not sure. */
  unsureClaim: 0.5,
} as const;

export type ChoiceAnswer = {
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

export type Answers = {
  attendance: ChoiceAnswer;
  ending: ChoiceAnswer;
  objection: ChoiceAnswer;
  claim?: number;
};

export type Verdict = "agrees" | "unsure" | "disagrees" | "hint";

/** Jev's confidence in its top choice, falling back to its probability. */
export function confidenceOf(answer: ChoiceAnswer): number {
  if (typeof answer.confidence === "number") return answer.confidence;
  return answer.probabilities?.[answer.choice] ?? 0;
}

/** What each kind of record expects Jev to hear. */
function expected(record: CallRecord): { attendance: string; ending?: string } {
  switch (record.kind) {
    case "payment":
      return { attendance: "held", ending: "paid" };
    case "call_back":
      return { attendance: "held", ending: "call_back" };
    case "lost":
      return { attendance: "held", ending: "lost" };
    case "no_show":
      return { attendance: "no_show" };
  }
}

export function computeVerdict(record: CallRecord | undefined, answers: Answers): Verdict {
  if (!record) return "hint";
  const want = expected(record);
  const t = VERDICT_THRESHOLDS;

  const checks: ChoiceAnswer[] = [answers.attendance];
  if (want.ending) checks.push(answers.ending);
  const wanted = [want.attendance, ...(want.ending ? [want.ending] : [])];

  // Disagrees: a confident contradiction, or a claim Jev rates as false.
  for (let i = 0; i < checks.length; i++) {
    const answer = checks[i];
    if (answer.choice !== wanted[i] && confidenceOf(answer) >= t.disagreeConfidence) return "disagrees";
  }
  if (typeof answers.claim === "number" && answers.claim <= t.disagreeClaim) return "disagrees";

  // Not sure: a weak top answer, any contradiction short of confident, or a
  // claim Jev can't call either way.
  for (let i = 0; i < checks.length; i++) {
    const answer = checks[i];
    if (confidenceOf(answer) < t.unsureConfidence) return "unsure";
    if (answer.choice !== wanted[i]) return "unsure";
  }
  if (typeof answers.claim === "number" && answers.claim < t.unsureClaim) return "unsure";

  return "agrees";
}
