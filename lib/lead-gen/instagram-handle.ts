// Relative import: the capture mutation in convex/ reads this file too, and
// Convex's bundler doesn't resolve the "@/" alias.
import { normalizeSocialHandle } from "../../convex/lib/normalization";

/** What the capture form and the capture mutation both say about a bad handle. */
export const INVALID_INSTAGRAM_HANDLE_MESSAGE = "Enter an Instagram handle or profile URL";

/** Instagram's own syntax: 1 to 30 lowercase letters, digits, dots and underscores. */
const INSTAGRAM_HANDLE_PATTERN = /^(?=.{1,30}$)(?=.*[a-z0-9])[a-z0-9._]+$/;

/**
 * The handle a lead gen capture stores for what a setter typed or pasted, or
 * `undefined` when it isn't an Instagram handle or profile URL: a post or
 * reel link, another site's URL, a placeholder answer ("na", "test"), fewer
 * than two letters or digits, or anything outside Instagram's syntax.
 *
 * The capture form runs this before it submits and the server runs it again,
 * so the two can't disagree about which handles are valid.
 */
export function normalizeInstagramHandle(rawHandleOrProfileUrl: string): string | undefined {
  const handle = normalizeSocialHandle(rawHandleOrProfileUrl, "instagram");
  return handle && INSTAGRAM_HANDLE_PATTERN.test(handle) ? handle : undefined;
}
