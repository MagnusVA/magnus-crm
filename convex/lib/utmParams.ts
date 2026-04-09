import { v } from "convex/values";

/**
 * Convex validator for the Calendly tracking/UTM object.
 *
 * Mirrors Calendly's `tracking` object structure (minus `salesforce_uuid`).
 * All fields are optional — a booking with no UTMs produces `undefined`
 * at the parent level, not an empty object.
 */
export const utmParamsValidator = v.object({
  utm_source: v.optional(v.string()),
  utm_medium: v.optional(v.string()),
  utm_campaign: v.optional(v.string()),
  utm_term: v.optional(v.string()),
  utm_content: v.optional(v.string()),
});

/**
 * TypeScript type derived from the validator.
 * Use this for function signatures and helper return types.
 */
export type UtmParams = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
};

/**
 * Extract and validate UTM parameters from a Calendly tracking object.
 *
 * Handles all edge cases from the Calendly API:
 * - tracking is missing (undefined/null) → returns undefined
 * - tracking is not an object → returns undefined
 * - individual fields are null (Calendly sends null, not undefined) → omitted
 * - individual fields are non-string → omitted
 * - all fields are null/missing → returns undefined (no empty objects)
 *
 * @param tracking - The raw `payload.tracking` value from the webhook
 * @returns UtmParams object if any UTM field has a value, undefined otherwise
 */
export function extractUtmParams(tracking: unknown): UtmParams | undefined {
  if (typeof tracking !== "object" || tracking === null || Array.isArray(tracking)) {
    return undefined;
  }

  const record = tracking as Record<string, unknown>;
  const result: UtmParams = {};
  let hasAnyValue = false;

  const fields = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
  ] as const;

  for (const field of fields) {
    const value = record[field];
    // Calendly sends null for empty UTM fields — treat as absent
    if (typeof value === "string" && value.length > 0) {
      result[field] = value;
      hasAnyValue = true;
    }
  }

  // Return undefined instead of empty object when no UTMs are present
  return hasAnyValue ? result : undefined;
}
