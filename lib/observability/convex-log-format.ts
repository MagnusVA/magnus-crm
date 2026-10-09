/**
 * Parser for the structured console lines written by
 * `convex/lib/observability/log.ts`: `[obs] <event> <json>`.
 */

export const OBS_LOG_MARKER = "[obs]";

export type ParsedObsLine = {
  event: string;
  attributes: Record<string, unknown>;
};

const OBS_LINE = /^\[obs\] ([A-Za-z0-9_.:-]+) (\{[\s\S]*\})\s*$/;

const CONTROL_CHARACTERS: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
};

/**
 * The log stream sends console arguments as their `object-inspect` form, so
 * `console.log("hi")` arrives as `'hi'`, with `'` and `\` backslash-escaped
 * and control characters written as `\xNN`. Returns the original string.
 */
export function decodeConsoleMessage(message: string): string {
  if (!message.startsWith("'")) return message;
  const body = message.endsWith("'") && message.length > 1 ? message.slice(1, -1) : message.slice(1);
  return body.replace(
    /\\x([0-9A-Fa-f]{2})|\\([btnfr])|\\(['\\])/g,
    (_match, hex: string | undefined, control: string | undefined, char: string | undefined) => {
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      if (control) return CONTROL_CHARACTERS[control] ?? "";
      return char ?? "";
    },
  );
}

/** Returns the event and attributes of a structured line, or `null` for any other console output. */
export function parseObsLine(message: string): ParsedObsLine | null {
  const decoded = decodeConsoleMessage(message.trim());
  if (!decoded.startsWith(OBS_LOG_MARKER)) return null;

  const match = OBS_LINE.exec(decoded);
  if (!match) return null;

  try {
    const parsed: unknown = JSON.parse(match[2]);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return { event: match[1], attributes: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}
