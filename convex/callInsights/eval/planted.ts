import { categoryKeys } from "../../../lib/callInsights/taxonomy";
import { shuffled, type Candidate } from "./judgePrompt";

/** Only applicable defects enter the draw, so every returned plant changes a real claim. */
export function plantDefects(
  caseId: string,
  candidates: readonly Candidate[],
): Candidate[] {
  const options: Candidate[] = [];
  for (const candidate of candidates) {
    const add = (
      plantedDefect: NonNullable<Candidate["plantedDefect"]>,
      patch: Partial<Candidate>,
    ) =>
      options.push({
        ...candidate,
        ...patch,
        labelId: undefined,
        originalKey: candidate.key,
        key: `${candidate.key}:planted:${plantedDefect}`,
        plantedDefect,
      });
    if (candidate.itemClass === "income") {
      const line = candidate.numberlessProspectLines?.[0];
      if (line !== undefined)
        add("invented_income", { lineStart: line, lineEnd: line });
      if (
        candidate.minMinor &&
        Number.isSafeInteger(candidate.minMinor * 10) &&
        Number.isSafeInteger((candidate.maxMinor ?? candidate.minMinor) * 10)
      )
        add("swapped_amount", {
          minMinor: candidate.minMinor * 10,
          maxMinor: (candidate.maxMinor ?? candidate.minMinor) * 10,
        });
      if (candidate.currency === "USD" || candidate.currency === "CAD")
        add("wrong_currency", {
          currency: candidate.currency === "USD" ? "CAD" : "USD",
        });
    }
    if (candidate.itemClass === "result" && candidate.resultKind === "promised")
      add("promise_as_paid", { resultKind: "paid" });
    if (
      candidate.itemClass !== "result" &&
      candidate.itemClass !== "attendance"
    ) {
      const category = categoryKeys(candidate.itemClass).find(
        (key) => key !== candidate.category,
      );
      if (category) add("wrong_category", { category });
    }
    if (
      candidate.itemClass === "objection" &&
      ["unresolved", "unknown"].includes(candidate.resolution ?? "unknown")
    )
      add("unsupported_resolution", {
        resolution: "resolved",
        resolutionLineIndex: candidate.lineStart,
      });
  }
  // Prefer distinct defect kinds within a case.
  const seen = new Set<string>();
  return shuffled(options, caseId)
    .filter((c) => {
      if (seen.has(c.plantedDefect!)) return false;
      seen.add(c.plantedDefect!);
      return true;
    })
    .slice(0, 2);
}
