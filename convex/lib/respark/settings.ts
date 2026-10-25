import type { Doc } from "../../_generated/dataModel";

// The respark settings (docs/plans/respark.md §3.3). `tenants.respark` isn't
// in the schema yet, so every tenant reads the default until it is.
export const DEFAULT_INACTIVE_AFTER_DAYS = 90;

/** Days without a touch after which a person counts as inactive. */
export function inactiveAfterDays(_tenant: Doc<"tenants"> | null): number {
  return DEFAULT_INACTIVE_AFTER_DAYS;
}
