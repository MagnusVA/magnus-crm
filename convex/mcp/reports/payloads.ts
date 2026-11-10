import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import {
  ANSWER_TOO_LARGE,
  MAX_ANSWER_BYTES,
  answerBytes,
  splitPayload,
} from "../../analytics/results";

/**
 * Pause between stored parts, as the web's Node build does: a 12 MB answer
 * must not spend the deployment's write budget in one burst.
 */
const PART_WRITE_SPACING_MS = 200;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raised when a newer run or an expiry took the request over mid-write. */
export const RUN_SUPERSEDED = "run_superseded";

/**
 * Stores an assistant answer in parts under its run and returns how many.
 * `finish` publishes them; until then no reader sees them.
 */
export async function storeAnswerParts(
  ctx: ActionCtx,
  run: { requestId: Id<"mcpReportRequests">; runToken: string },
  json: string,
): Promise<number> {
  if (answerBytes(json) > MAX_ANSWER_BYTES) throw new Error(ANSWER_TOO_LARGE);
  const parts = splitPayload(json);
  for (let index = 0; index < parts.length; index++) {
    if (index > 0) await sleep(PART_WRITE_SPACING_MS);
    const stored: boolean = await ctx.runMutation(
      internal.mcp.reports.admission.storePart,
      { ...run, index, json: parts[index] },
    );
    if (!stored) throw new Error(RUN_SUPERSEDED);
  }
  return parts.length;
}
