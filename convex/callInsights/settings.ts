import type { Doc, Id } from "../_generated/dataModel";
import { TAXONOMY_VERSION } from "../../lib/callInsights/taxonomy";
import {
  DEFAULT_EXTRACTION_MODEL,
  PROMPT_VERSION,
  THRESHOLDS_VERSION,
  type CallInsightsSettings,
  type RunConfig,
} from "./validators";

/** The one monthly limit when the owner hasn't set another. */
export const DEFAULT_MONTHLY_CAP_USD = 60;
export const DEFAULT_EVAL_MONTHLY_USD = 10;

/**
 * A tenant's Call insights settings, or null when the feature is off.
 * `tenants.callInsights` absent means off: nothing is read and no shared
 * write path does anything new.
 */
export function effectiveSettings(
  tenant: Pick<Doc<"tenants">, "callInsights"> | null | undefined,
): CallInsightsSettings | null {
  const settings = tenant?.callInsights;
  if (!settings || settings.mode === "off") return null;
  return settings;
}

/** The settings a tenant gets the first time someone turns the feature on. */
export function initialSettings(
  userId: Id<"users">,
  now: number,
): CallInsightsSettings {
  return {
    mode: "shadow",
    suggestions: "hidden",
    amountPrefill: false,
    noShowCertain: false,
    monthlyCapUsd: DEFAULT_MONTHLY_CAP_USD,
    evalMonthlyUsd: DEFAULT_EVAL_MONTHLY_USD,
    itemCheck: true,
    model: DEFAULT_EXTRACTION_MODEL,
    enabledAt: now,
    changedAt: now,
    changedByUserId: userId,
  };
}

/** The versions a serving read made now would carry. */
export function servingConfig(settings: CallInsightsSettings): RunConfig {
  return {
    model: settings.model,
    promptVersion: PROMPT_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    thresholdsVersion: THRESHOLDS_VERSION,
    itemCheck: settings.itemCheck,
  };
}

export function sameConfig(a: RunConfig, b: RunConfig): boolean {
  return (
    a.model === b.model &&
    a.promptVersion === b.promptVersion &&
    a.taxonomyVersion === b.taxonomyVersion &&
    a.thresholdsVersion === b.thresholdsVersion &&
    a.itemCheck === b.itemCheck
  );
}
