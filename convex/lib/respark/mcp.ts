import { v } from "convex/values";
import { maskContactText } from "./people";

export const mcpPersonTextValidator = v.object({
  text: v.string(), personSupplied: v.literal(true), truncated: v.boolean(),
});

// instagram.com/p/<code>, /reel/<code>, /reels/<code> or /tv/<code>, with
// nothing before or after. A shortcode always has a letter in it.
const INSTAGRAM_POST_LINK = /^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/;

/**
 * Whether an origin is a link the agent may pass back whole. The contact
 * mask would eat a run of digits in a post's shortcode, so a plain Instagram
 * post or reel link skips it. Nothing else does: the capture accepts any URL
 * for a post origin, so a link with a username part
 * (instagram.com/15550109999/p/AbC), a code that is only digits, or another
 * site's URL is masked like the free text a lead gen types for other origins.
 */
export function isOriginLink(originKind: string, originValue: string): boolean {
  if (originKind !== "post" && originKind !== "reel") return false;
  const code = INSTAGRAM_POST_LINK.exec(originValue)?.[1];
  return code !== undefined && /[A-Za-z]/.test(code);
}

/** One response budget, including children of every returned person. */
export class McpProjectionBudget {
  private rowsLeft: number;
  private textBytesLeft = 24_000;
  isPartial = false;
  textTruncated = false;

  constructor(reservedRows = 0) { this.rowsLeft = 50 - reservedRows; }

  take<T>(rows: T[], limit = 25): T[] {
    const result = rows.slice(0, Math.max(0, Math.min(limit, this.rowsLeft)));
    this.rowsLeft -= result.length;
    this.isPartial ||= result.length < rows.length;
    return result;
  }

  /**
   * Trims text to the budget. Free text is masked for contact details first.
   * A handle or a post link is an identifier the agent passes back, and the
   * phone pattern would eat the digits in `user_12345678` or a reel's id, so
   * those are trimmed only: pass `mask: false`.
   */
  text(value: string, options: { mask?: boolean } = {}): string {
    const safe = options.mask === false ? value : maskContactText(value, []);
    let result = "";
    let bytes = 0;
    for (const char of safe) {
      const width = new TextEncoder().encode(char).byteLength;
      if (result.length + char.length > 500 || bytes + width > this.textBytesLeft) break;
      result += char;
      bytes += width;
    }
    this.textBytesLeft -= bytes;
    this.textTruncated ||= result !== safe;
    this.isPartial ||= result !== safe;
    return result;
  }

  personText(value: string, options: { mask?: boolean } = {}) {
    const safe = options.mask === false ? value : maskContactText(value, []);
    const text = this.text(safe, options);
    return { text, personSupplied: true as const, truncated: text !== safe };
  }
}
