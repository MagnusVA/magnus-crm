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
export type PartialAnswers = Partial<Answers>;

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

/**
 * Several readings of one question become one answer: the probabilities are
 * averaged, so two readings that pick different answers leave a weak top
 * answer. A reading without probabilities counts its confidence for its
 * choice alone.
 */
export function combineChoice(readings: ChoiceAnswer[]): { answer: ChoiceAnswer; split: boolean } {
  if (readings.length === 0) throw new Error("No readings to combine");
  if (readings.length === 1) return { answer: readings[0], split: false };
  const sums: Record<string, number> = {};
  for (const reading of readings) {
    const dist = reading.probabilities ?? { [reading.choice]: confidenceOf(reading) };
    for (const [option, p] of Object.entries(dist)) sums[option] = (sums[option] ?? 0) + p;
  }
  const probabilities: Record<string, number> = {};
  for (const [option, sum] of Object.entries(sums)) probabilities[option] = sum / readings.length;
  // Ties keep the first reading's choice, so the result never depends on key order alone.
  let choice = readings[0].choice;
  for (const [option, p] of Object.entries(probabilities))
    if (p > (probabilities[choice] ?? 0)) choice = option;
  return {
    answer: { choice, confidence: probabilities[choice], probabilities },
    split: new Set(readings.map((r) => r.choice)).size > 1,
  };
}

/** The claim's readings average; two that differ by more than half split. */
export function combineClaim(readings: number[]): { claim: number; split: boolean } {
  if (readings.length === 0) throw new Error("No readings to combine");
  const claim = readings.reduce((sum, n) => sum + n, 0) / readings.length;
  return { claim, split: Math.max(...readings) - Math.min(...readings) > 0.5 };
}

/**
 * The record is the closer's word, so the claim leads. Disagrees needs the
 * claim rated as false, or a confident contradiction the claim doesn't
 * outweigh. A confident contradiction of a claim Jev still rates as likely,
 * or readings that split on a question that matters, is Not sure.
 */
export function computeVerdict(
  record: CallRecord | undefined,
  answers: Answers,
  split: readonly string[] = [],
): Verdict {
  if (!record) return "hint";
  const want = expected(record);
  const t = VERDICT_THRESHOLDS;

  const checks: ChoiceAnswer[] = [answers.attendance];
  if (want.ending) checks.push(answers.ending);
  const wanted = [want.attendance, ...(want.ending ? [want.ending] : [])];
  const claim = answers.claim;

  if (typeof claim === "number" && claim <= t.disagreeClaim) return "disagrees";
  // Readings that split on a question that matters can't disagree.
  const matters = ["attendance", ...(want.ending ? ["ending"] : []), "claim"];
  if (split.some((question) => matters.includes(question))) return "unsure";
  const contradicted = checks.some(
    (answer, i) => answer.choice !== wanted[i] && confidenceOf(answer) >= t.disagreeConfidence,
  );
  if (contradicted && (typeof claim !== "number" || claim < t.unsureClaim)) return "disagrees";

  // Not sure: a weak top answer, any contradiction the claim outweighs, or a
  // claim Jev can't call either way.
  for (let i = 0; i < checks.length; i++) {
    const answer = checks[i];
    if (confidenceOf(answer) < t.unsureConfidence) return "unsure";
    if (answer.choice !== wanted[i]) return "unsure";
  }
  if (typeof claim === "number" && claim < t.unsureClaim) return "unsure";

  return "agrees";
}
