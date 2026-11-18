import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

// What the Automatic results page knows about each kind of result and each
// level. The controls, the grading queue and the scorecard are drawn from
// these lists, so a new kind or level is a new entry here, not a new screen.

export type AutomationSettingsView = FunctionReturnType<typeof api.automation.settings.getSettings>;
export type AutomationScorecard = FunctionReturnType<typeof api.automation.scorecard.getAutomationScorecard>;
export type GradeTally = FunctionReturnType<typeof api.automation.grading.getGradeTally>;

/** The kinds the backend has settings for today. */
export type AutomationKind = keyof AutomationSettingsView["effective"];
/** The levels the backend accepts today. */
export type StoredLevel = AutomationSettingsView["effective"][AutomationKind];
/** Every level the page shows, including ones not available yet. */
export type Level = StoredLevel | "automatic";

export type KindDefinition = {
  kind: AutomationKind;
  /** Short name for tabs and the scorecard's rows. */
  shortName: string;
  /** What the CRM does at this kind's highest level, in one sentence. */
  sentence: string;
  /** One small line under the sentence. */
  detail: string;
  /** Clean blind grades on proposals the rule would write before Automatic can be earned. */
  cleanTarget: number;
  /** The kind reads Whop payments, so it cannot work without a Whop connection. */
  needsWhop: boolean;
  /** What turning the kind up to a level does, when it differs from the level's own words. */
  raiseWords?: Partial<Record<Level, string>>;
};

export const AUTOMATION_KINDS: readonly KindDefinition[] = [
  {
    kind: "payment_win",
    shortName: "Won from a payment",
    sentence: "When Whop reports a first payment tied to one deal, the CRM records it and closes the deal as won.",
    detail: "The closer then confirms attendance.",
    cleanTarget: 300,
    needsWhop: true,
  },
  {
    kind: "additional_payment",
    shortName: "Later payment",
    sentence: "When Whop reports a later payment on a membership you confirmed, the CRM adds it to the won deal.",
    detail: "Raises cash and the older “sales” counts.",
    cleanTarget: 300,
    needsWhop: true,
  },
];

export type LevelDefinition = {
  value: Level;
  label: string;
  /** False shows the level locked. */
  available: boolean;
  /** Why a locked level can't be chosen. */
  lockedReason?: string;
  /** The explainer table: what the system does. */
  does: string;
  /** The explainer table: what changes in the CRM. */
  changes: string;
  /** The confirm line for turning a kind up to this level. */
  raiseWords: string;
};

export const LEVELS: readonly LevelDefinition[] = [
  {
    value: "off",
    label: "Off",
    available: true,
    does: "Nothing for this kind.",
    changes: "Nothing.",
    raiseWords: "The CRM stops deciding for this kind.",
  },
  {
    value: "shadow",
    label: "Shadow",
    available: true,
    does: "Decides and stores the decision. No one is told and nothing is shown to closers.",
    changes: "Nothing. The decisions are graded to build the record.",
    raiseWords: "The CRM will decide and log, and change nothing.",
  },
  {
    value: "ask",
    label: "Ask",
    available: true,
    does: "Shows the proposal to the closer or to Billing as one confirmation, with what it will do.",
    changes: "Only what the person confirms. The checks run again when they tap.",
    raiseWords: "Closers will start seeing Whop payments to confirm.",
  },
  {
    value: "automatic",
    label: "Automatic",
    available: false,
    lockedReason: "Not available yet",
    does: "Writes it.",
    changes: "The result, marked as recorded automatically, with a way to put it right.",
    raiseWords: "The CRM will write these results without a tap.",
  },
];

export const LOWER_WORDS = "Proposals waiting under this kind are cancelled. Nothing resumes by itself.";

export function levelRank(level: Level) {
  return LEVELS.findIndex((definition) => definition.value === level);
}

export function levelDefinition(level: Level) {
  return LEVELS.find((definition) => definition.value === level) ?? LEVELS[0];
}

export function kindDefinition(kind: AutomationKind) {
  return AUTOMATION_KINDS.find((definition) => definition.kind === kind) ?? AUTOMATION_KINDS[0];
}

/** "41", or "500+" when the server stopped counting. */
export function countWords(count: number, capped: boolean) {
  return capped ? `${count}+` : String(count);
}

/** "3 days", "5 hours", "12 minutes", "under a minute". */
export function ageWords(since: number, now: number) {
  const ms = Math.max(0, now - since);
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return days === 1 ? "1 day" : `${days} days`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return hours === 1 ? "1 hour" : `${hours} hours`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 1) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return "under a minute";
}

/** The amount in whole units for a minor-unit figure, as typed in an input. */
export function minorToInput(amountMinor: number | undefined) {
  return amountMinor === undefined ? "" : (amountMinor / 100).toFixed(2);
}

/** "1,500.00" typed -> 150000; anything else -> undefined. */
export function inputToMinor(value: string) {
  const cleaned = value.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const minor = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(minor) ? minor : undefined;
}
