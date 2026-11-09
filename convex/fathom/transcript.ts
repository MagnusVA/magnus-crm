import { z } from "zod";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { rejectRequest } from "../lib/observability/errors";
import type { TranscriptLine } from "./validators";

/** Action-side internal helper. Caller must authorize the recording first. Pages are one-based, 1..200 lines. */
export async function readTranscriptPage(
  ctx: Pick<ActionCtx, "storage" | "runQuery">,
  recordingId: Id<"callRecordings">,
  page: number,
  pageSize: number,
): Promise<{ lines: TranscriptLine[]; page: number; pageCount: number }> {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 200
  )
    throw rejectRequest(
      "fathom.invalid_page",
      "Choose a positive page and 1 to 200 lines per page.",
    );
  const access = await ctx.runQuery(
    internal.fathom.recordings.transcriptAccess,
    { recordingId },
  );
  if (!access?.storageId || access.expiresAt <= Date.now())
    return { lines: [], page, pageCount: 0 };
  const blob = await ctx.storage.get(access.storageId);
  if (!blob) return { lines: [], page, pageCount: 0 };
  const lines = z
    .array(
      z.object({
        speaker: z.string(),
        email: z.string().optional(),
        timestamp: z.string(),
        text: z.string(),
      }),
    )
    .parse(JSON.parse(await blob.text()));
  return {
    lines: lines.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageCount: Math.ceil(lines.length / pageSize),
  };
}
