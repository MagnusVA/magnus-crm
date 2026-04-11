/**
 * Shared payload extraction utilities used across webhook and pipeline handlers.
 * Reduces duplication of common parsing patterns across calendly.ts, inviteeCreated.ts, etc.
 */

/**
 * Type guard: check if a value is a plain object (record).
 * Used to safely typecast and access nested payload properties.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract a non-empty string from a record by key.
 * Returns undefined if the key is missing, empty, or not a string.
 * Used throughout webhook/pipeline payload parsing.
 */
export function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
