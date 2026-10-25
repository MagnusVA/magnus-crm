// Labels and summaries for the Respark screen (docs/plans/respark.md §6.1).

export const RESPARK_BUCKET_LABELS: Record<number, string> = {
  1: "Qualified, never booked",
  2: "Never qualified",
  3: "Inactive",
  4: "Had a call, deal lost",
  5: "Not a fit",
};

export function resparkBucketLabel(bucket: number) {
  return RESPARK_BUCKET_LABELS[bucket] ?? `Bucket ${bucket}`;
}

export type ResparkItemResult = "resparked" | "not_a_fit" | "skipped";

export type BatchSummary = {
  worked: number;
  total: number;
  entries: number;
  notAFit: number;
  skipped: number;
  /** From the claim to the last action, or null before any action. */
  durationMs: number | null;
};

export function summarizeBatch(batch: {
  createdAt: number;
  items: { result: ResparkItemResult | null; workedAt: number | null }[];
}): BatchSummary {
  let entries = 0;
  let notAFit = 0;
  let skipped = 0;
  let lastAction: number | null = null;
  for (const item of batch.items) {
    if (item.result === "resparked") entries += 1;
    else if (item.result === "not_a_fit") notAFit += 1;
    else if (item.result === "skipped") skipped += 1;
    if (item.result !== null && item.workedAt !== null) {
      lastAction = Math.max(lastAction ?? item.workedAt, item.workedAt);
    }
  }
  return {
    worked: entries + notAFit + skipped,
    total: batch.items.length,
    entries,
    notAFit,
    skipped,
    durationMs: lastAction === null ? null : Math.max(0, lastAction - batch.createdAt),
  };
}

/** "2 h 10 min", "45 min", or "under a minute". */
export function formatBatchDuration(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The profile URL for a stored handle, or null when there is none. */
export function instagramProfileUrl(handle: string | null) {
  const clean = handle?.trim().replace(/^@+/, "");
  return clean ? `https://instagram.com/${encodeURIComponent(clean)}` : null;
}

/** Whether a key press came from a place where the user types. */
export function isTypingTarget(target: EventTarget | null) {
  if (!target || typeof target !== "object" || !("tagName" in target)) return false;
  const element = target as { tagName: string; isContentEditable?: boolean };
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}

// Dialogs, sheets, popovers, menus and listboxes. Radix unmounts closed ones,
// so any match in the document is open.
const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  "[data-radix-popper-content-wrapper]",
].join(", ");

type OverlayRoot = { querySelector: (selectors: string) => unknown };

/** Whether a key press came from, or happened behind, an open overlay. */
export function isOverlayActive(target: EventTarget | null, root: OverlayRoot | null) {
  const element = target as { closest?: (selectors: string) => unknown } | null;
  if (typeof element?.closest === "function" && element.closest(OVERLAY_SELECTOR)) return true;
  return root?.querySelector(OVERLAY_SELECTOR) != null;
}
