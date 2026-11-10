import { v } from "convex/values";
import { maskContactText } from "./people";

export const mcpPersonTextValidator = v.object({
  text: v.string(), personSupplied: v.literal(true), truncated: v.boolean(),
});

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

  text(value: string): string {
    const safe = maskContactText(value, []);
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

  personText(value: string) {
    const safe = maskContactText(value, []);
    const text = this.text(safe);
    return { text, personSupplied: true as const, truncated: text !== safe };
  }
}
