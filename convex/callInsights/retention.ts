import type { Doc } from "../_generated/dataModel";

/** Fathom transcripts are kept 90 days; rows from before `transcriptExpiresAt` existed use this. */
export const TRANSCRIPT_RETENTION_MS = 90 * 86_400_000;

export function transcriptExpiresAt(
  recording: Pick<
    Doc<"callRecordings">,
    "transcriptExpiresAt" | "recordingStartAt"
  >,
): number {
  return (
    recording.transcriptExpiresAt ??
    recording.recordingStartAt + TRANSCRIPT_RETENTION_MS
  );
}

/**
 * True once a recording's transcript is deleted or past its expiry. Prospect
 * words kept by Call insights live exactly as long as the transcript: from
 * this moment nothing may show, save or use them, even before the daily
 * cleanup has blanked the stored copies.
 */
export function transcriptGone(
  recording: Pick<
    Doc<"callRecordings">,
    | "transcriptStorageId"
    | "transcriptDeletedAt"
    | "transcriptExpiresAt"
    | "recordingStartAt"
  >,
  now: number,
): boolean {
  return (
    !recording.transcriptStorageId ||
    recording.transcriptDeletedAt !== undefined ||
    transcriptExpiresAt(recording) <= now
  );
}
