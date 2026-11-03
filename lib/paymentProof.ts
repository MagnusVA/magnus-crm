/**
 * The proof rule's limits, shared by the payment writes in Convex and the web
 * dialogs (docs/plans/closer-assistant.md §5.3). Convex enforces them; the
 * dialogs only explain them.
 */

/** The largest proof file a payment takes: 10 MB. */
export const PROOF_MAX_BYTES = 10 * 1024 * 1024;

/** The proof file types a payment takes: JPEG, PNG, GIF and PDF. */
export const PROOF_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "application/pdf",
] as const;

/** What a closer sees when a payment has no proof file. */
export const PROOF_REQUIRED_MESSAGE =
  "Add a proof file: a receipt or screenshot of the payment.";
