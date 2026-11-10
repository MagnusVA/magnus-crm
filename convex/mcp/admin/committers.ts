import type { Committer } from "./prepare";
import { coverageCommitter } from "./writes/coverage";
import { goalCommitter } from "./writes/goals";
import { nextStepCommitter } from "./writes/nextStep";
import { decideOpinionCommitter } from "./writes/opinions";
import { correctPaymentCommitter, reviewPaymentsCommitter } from "./writes/payments";
import { repairCommitter } from "./writes/repairs";
import { lossCommitter, noShowCommitter } from "./writes/results";

/**
 * Every admin change, by its prepare tool's name. `magnus_commit` and the
 * approval page look a stored change up here, so each committer module is
 * imported explicitly: a registry filled at import time would be empty in a
 * function file that never imports the tool.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const COMMITTERS: Record<string, Committer<any>> = Object.fromEntries(
  [
    correctPaymentCommitter,
    reviewPaymentsCommitter,
    noShowCommitter,
    lossCommitter,
    nextStepCommitter,
    decideOpinionCommitter,
    repairCommitter,
    goalCommitter,
    coverageCommitter,
  ].map((c) => [c.tool, c]),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function committerFor(tool: string): Committer<any> | null {
  return COMMITTERS[tool] ?? null;
}
