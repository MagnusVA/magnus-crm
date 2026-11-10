import { v } from "convex/values";
import { maskContactText } from "./people";

export const mcpPersonTextValidator = v.object({
  text: v.string(), personSupplied: v.literal(true), truncated: v.boolean(),
});

// instagram.com/p/<code>, /reel/<code>, /reels/<code> or /tv/<code>, with an
// optional username before it and nothing after.
const INSTAGRAM_POST_LINK =
  /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?$/;

/**
 * Whether an origin is a link the agent may pass back whole. Only a post or
 * reel origin whose value is an Instagram post or reel link qualifies: the
 * capture accepts any URL for those kinds, and a URL such as
 * https://example.com/pat@example.com must still be masked. Every other
 * origin (a story label, "follower") is free text a lead gen typed.
 */
export function isOriginLink(originKind: string, originValue: string): boolean {
  return (originKind === "post" || originKind === "reel") && INSTAGRAM_POST_LINK.test(originValue);
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
