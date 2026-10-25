import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";

// The tenant's respark settings (docs/plans/respark.md §3.3, §5.5). The hold
// isn't a setting: a batch is always held until the business day ends.

export const resparkSettingsValidator = v.object({
  inactiveAfterDays: v.number(),
  batchSize: v.number(),
});

export type ResparkSettings = Infer<typeof resparkSettingsValidator>;

export const DEFAULT_RESPARK_SETTINGS: ResparkSettings = {
  inactiveAfterDays: 90,
  batchSize: 45,
};

export const INACTIVE_AFTER_DAYS_RANGE = { min: 30, max: 365 } as const;
export const BATCH_SIZE_RANGE = { min: 10, max: 100 } as const;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The tenant's settings, with the defaults where it has none. */
export function readResparkSettings(tenant: Pick<Doc<"tenants">, "respark">): ResparkSettings {
  return tenant.respark ?? DEFAULT_RESPARK_SETTINGS;
}

/** The newest last touch time at which a person is inactive at `now`. */
export function inactiveCutoff(now: number, inactiveAfterDays: number): number {
  return now - inactiveAfterDays * DAY_MS;
}

/**
 * How many whole days a person has been inactive at `now`, or null when they
 * aren't (plan §4.3): a non-merged person whose last touch is at least
 * `inactiveAfterDays` old. Worked out at read time; nothing stores it.
 */
export function inactiveDays(
  lead: Pick<Doc<"leads">, "status" | "lastTouch">,
  inactiveAfterDays: number,
  now: number,
): number | null {
  if (lead.status === "merged" || !lead.lastTouch) return null;
  if (lead.lastTouch.occurredAt > inactiveCutoff(now, inactiveAfterDays)) return null;
  return Math.floor((now - lead.lastTouch.occurredAt) / DAY_MS);
}

/** Days without a touch after which a person counts as inactive. */
export function inactiveAfterDays(tenant: Pick<Doc<"tenants">, "respark"> | null): number {
  return tenant ? readResparkSettings(tenant).inactiveAfterDays : DEFAULT_RESPARK_SETTINGS.inactiveAfterDays;
}
