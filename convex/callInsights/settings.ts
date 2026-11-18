import type { Doc, Id } from "../_generated/dataModel";
import { TAXONOMY_VERSION } from "../../lib/callInsights/taxonomy";
import {
  DEFAULT_EXTRACTION_MODEL,
  EVIDENCE_PROMPT_VERSION,
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

const CALL_KINDS = ["call_back", "payment_owed", "refusal_loss"] as const;
type EvidenceTenant = {
  resultAutomation?: {
    enabled?: boolean;
    pausedAt?: number;
    kinds?: Partial<Record<(typeof CALL_KINDS)[number], { mode?: string }>>;
    paidOnCallAlert?: { mode?: string };
  };
};

export function callEvidenceWanted(
  tenant: EvidenceTenant | null | undefined,
): boolean {
  const settings = tenant?.resultAutomation;
  // `pausedAt` records the last pause and stays after a resume, so `enabled`
  // alone says whether automation is running.
  if (settings?.enabled !== true) return false;
  const alert = settings.paidOnCallAlert?.mode;
  return (
    alert === "shadow" ||
    alert === "on" ||
    CALL_KINDS.some((kind) => {
      const mode = settings.kinds?.[kind]?.mode;
      return mode === "shadow" || mode === "ask" || mode === "automatic";
    })
  );
}

/** The versions a serving read made now would carry. */
export function servingConfig(
  settings: CallInsightsSettings,
  tenant?: EvidenceTenant | null,
): RunConfig {
  const callEvidence = callEvidenceWanted(tenant);
  return {
    model: settings.model,
    promptVersion: callEvidence ? EVIDENCE_PROMPT_VERSION : PROMPT_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    thresholdsVersion: THRESHOLDS_VERSION,
    itemCheck: settings.itemCheck,
    ...(callEvidence ? { callEvidence: true } : {}),
  };
}

export function sameConfig(a: RunConfig, b: RunConfig): boolean {
  return (
    a.model === b.model &&
    a.promptVersion === b.promptVersion &&
    a.taxonomyVersion === b.taxonomyVersion &&
    a.thresholdsVersion === b.thresholdsVersion &&
    a.itemCheck === b.itemCheck &&
    (a.callEvidence ?? false) === (b.callEvidence ?? false)
  );
}
