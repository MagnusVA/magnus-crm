import {
  buildDecisionsRequest,
  type DecisionsRequest,
} from "../secondOpinion/jev";
import { buildQuestionGroups } from "../secondOpinion/questions";
import { buildState, type SpeakerRole } from "../secondOpinion/transcript";
import { confidenceOf, type PartialAnswers } from "../secondOpinion/verdict";
import { linesAround, renderLines, type PreparedLine } from "./transcriptPrep";
import type { EarlyReading, ResultEvidence } from "./validators";

export function buildReadingRequests(a: {
  kind: "full" | "attendance_only";
  callKind: "new call" | "follow-up call";
  program?: string;
  recordedMinutes: number;
  summary?: string;
  actionItems: string[];
  lines: Array<{ atSeconds: number; role: SpeakerRole; text: string }>;
}): Array<{ key: string; request: DecisionsRequest }> {
  const groups = buildQuestionGroups(undefined).filter(
    ({ group }) =>
      group === "attendance" || (a.kind === "full" && group === "outcome"),
  );
  return groups.flatMap(({ group, questions }) =>
    [true, false].map((withSummary) => ({
      key: `${group === "attendance" ? "attendance" : "ending"}:${withSummary ? "with" : "without"}`,
      request: buildDecisionsRequest(
        buildState({ ...a, withSummary }),
        undefined,
        questions,
      ),
    })),
  );
}

export function combineReadingAnswers(
  parsed: Array<{ key: string; answers: PartialAnswers }>,
  incomplete: boolean,
): EarlyReading {
  const out: EarlyReading = { incomplete };
  for (const name of ["attendance", "ending"] as const) {
    const readings = parsed.filter(
      ({ key }) => key === `${name}:with` || key === `${name}:without`,
    );
    // No ending requests are made for an attendance-only run. If both ending
    // requests failed in a full run, the caller passes incomplete: true.
    if (name === "ending" && readings.length === 0) continue;
    const pair: NonNullable<EarlyReading[typeof name]> = {};
    for (const [suffix, field] of [
      ["with", "withSummary"],
      ["without", "withoutSummary"],
    ] as const) {
      const answer = readings.find(({ key }) => key === `${name}:${suffix}`)
        ?.answers[name];
      if (answer)
        pair[field] = {
          choice: answer.choice,
          confidence: confidenceOf(answer),
        };
      else out.incomplete = true;
    }
    if (pair.withSummary || pair.withoutSummary) out[name] = pair;
  }
  return out;
}

export function buildResultCheck(
  result: ResultEvidence,
  lines: PreparedLine[],
): {
  state: string;
  questions: Record<string, { type: "noul"; instructions: string }>;
} | null {
  if (!result.codeChecksPassed) return null;
  let instructions: string;
  switch (result.kind) {
    case "paid": {
      const { amountMinor, currency } = result.values;
      const amount =
        amountMinor === undefined
          ? undefined
          : new Intl.NumberFormat("en-US", {
              maximumFractionDigits: 2,
            }).format(amountMinor / 100);
      const money = [amount, currency]
        .filter((part) => part !== undefined && part !== "")
        .join(" ");
      instructions = `The prospect agreed to pay${money ? ` ${money}` : ""} on this call.`;
      break;
    }
    case "promised":
      instructions = "The prospect promised to pay later, not on this call.";
      break;
    case "call_back":
      instructions =
        "The prospect asked to be contacted again at a later time.";
      break;
    case "lost":
      instructions = "The prospect declined to buy.";
      break;
    default:
      return null;
  }
  const selected = result.quotes.flatMap(({ lineIndex }) =>
    linesAround(lines, lineIndex, 3),
  );
  const ordered = [
    ...new Map(selected.map((line) => [line.index, line])).values(),
  ].sort((a, b) => a.index - b.index);
  return {
    state: renderLines(ordered),
    questions: { result: { type: "noul", instructions } },
  };
}
