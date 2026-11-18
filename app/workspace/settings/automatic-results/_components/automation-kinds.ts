import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

// What the Automatic results page knows about each kind of result and each
// level. The controls, the certificates, the grading queue and the scorecard
// are drawn from these lists, so a new kind or level is a new entry here, not
// a new screen.

export type AutomationSettingsView = FunctionReturnType<typeof api.automation.settings.getSettings>;
export type AutomationScorecard = FunctionReturnType<typeof api.automation.scorecard.getAutomationScorecard>;
export type GradeTally = FunctionReturnType<typeof api.automation.grading.getGradeTally>;
export type CertificateView = FunctionReturnType<typeof api.automation.certificates.getCertificates>[number];
export type AutomaticStatus = AutomationSettingsView["automatic"][AutomationKind];
export type Breaker = AutomationSettingsView["breakers"][number];
export type BreakerReason = Breaker["reason"];
export type WrongField = FunctionReturnType<typeof api.automation.grading.listUnsure>[number]["wrongFields"][number];

/** Every kind the backend has settings for. */
export type AutomationKind = keyof AutomationSettingsView["automatic"];
/** The levels a kind can be at. Automatic is written only by a promotion. */
export type Level = NonNullable<AutomationSettingsView["configured"]>["kinds"]["payment_win"]["mode"];
/** Kept for older imports: the stored level is the level. */
export type StoredLevel = Level;
/** The levels `setKindMode` accepts. */
export type SettableLevel = Exclude<Level, "automatic">;
export type AlertLevel = NonNullable<NonNullable<AutomationSettingsView["configured"]>["paidOnCallAlert"]>["mode"];

export type KindSource = "payment" | "call";

export type KindDefinition = {
  kind: AutomationKind;
  /** Short name for tabs, the scorecard's rows, and the typed confirmation. */
  shortName: string;
  /** Payment kinds read Whop; call kinds read recorded calls. */
  source: KindSource;
  /** What the CRM does at this kind's highest level, in one sentence. */
  sentence: string;
  /** One small line under the sentence. */
  detail?: string;
  /** Clean graded proposals in the sample before Automatic can be earned. */
  cleanTarget: number;
  /** The kind reads Whop payments, so it cannot work without a Whop connection. */
  needsWhop: boolean;
  /** What one automatic write of this kind did, for the list of automatic writes. */
  recordedWords: string;
  /** The fields a grader or an auditor can mark wrong on a write of this kind. */
  wrongFields: readonly WrongField[];
  /** What turning the kind up to a level does, when it differs from the level's own words. */
  raiseWords?: Partial<Record<Level, string>>;
};

const PAYMENT_WRONG_FIELDS: readonly WrongField[] = [
  "person", "deal", "amount", "currency", "type", "program", "credit", "should_abstain",
];

export const AUTOMATION_KINDS: readonly KindDefinition[] = [
  {
    kind: "payment_win",
    shortName: "Won from a payment",
    source: "payment",
    sentence: "When Whop reports a first payment tied to one deal, the CRM records it and closes the deal as won.",
    detail: "The closer then confirms attendance.",
    cleanTarget: 300,
    needsWhop: true,
    recordedWords: "Recorded a Whop payment and closed the deal as won",
    wrongFields: PAYMENT_WRONG_FIELDS,
  },
  {
    kind: "additional_payment",
    shortName: "Later payment",
    source: "payment",
    sentence: "When Whop reports a later payment on a membership you confirmed, the CRM adds it to the won deal.",
    detail: "Raises cash and the older “sales” counts.",
    cleanTarget: 300,
    needsWhop: true,
    recordedWords: "Added a later Whop payment to the won deal",
    wrongFields: PAYMENT_WRONG_FIELDS,
  },
  {
    kind: "call_back",
    shortName: "Call back",
    source: "call",
    sentence: "When the prospect agrees to a call-back, the CRM sets the reminder and marks the meeting held.",
    cleanTarget: 60,
    needsWhop: false,
    recordedWords: "Set a call-back from the call and marked the meeting held",
    wrongFields: ["person", "deal", "purpose", "time", "method", "attendance", "should_abstain"],
    raiseWords: {
      shadow: "The CRM will read each recorded call for a call-back and log it, and change nothing.",
      ask: "Closers will see call-backs from their calls to confirm with one tap.",
    },
  },
  {
    kind: "payment_owed",
    shortName: "Payment owed",
    source: "call",
    sentence: "When the prospect promises a payment, the CRM sets a “payment owed” task with the amount and date.",
    detail: "A payment closes it.",
    cleanTarget: 60,
    needsWhop: false,
    recordedWords: "Set a payment-owed task from the call and marked the meeting held",
    wrongFields: ["person", "deal", "purpose", "time", "method", "amount", "currency", "attendance", "should_abstain"],
    raiseWords: {
      shadow: "The CRM will read each recorded call for a promised payment and log it, and change nothing.",
      ask: "Closers will see promised payments from their calls to confirm with one tap.",
    },
  },
  {
    kind: "refusal_loss",
    shortName: "Refused on the call",
    source: "call",
    sentence: "When the prospect refuses, the CRM closes the deal as lost after a notice the closer has seen.",
    detail: "Counts in the closer's win rate.",
    cleanTarget: 300,
    needsWhop: false,
    recordedWords: "Closed the deal as lost after the prospect refused on the call",
    wrongFields: ["person", "deal", "false_loss", "attendance", "should_abstain"],
    raiseWords: {
      shadow: "The CRM will read each recorded call for a refusal and log it, and change nothing.",
      ask: "Closers will see refusals from their calls to confirm with one tap.",
    },
  },
];

export const CALL_KINDS = AUTOMATION_KINDS.filter((definition) => definition.source === "call");
export const PAYMENT_KINDS = AUTOMATION_KINDS.filter((definition) => definition.source === "payment");

/** The refusal sentence names the notice hours the owner set. */
export function kindSentence(definition: KindDefinition, noticeHours: number) {
  return definition.kind === "refusal_loss"
    ? `When the prospect refuses, the CRM closes the deal as lost after a ${noticeHours}-hour notice the closer has seen.`
    : definition.sentence;
}

export type LevelDefinition = {
  value: Level;
  label: string;
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
    does: "Nothing for this kind.",
    changes: "Nothing.",
    raiseWords: "The CRM stops deciding for this kind.",
  },
  {
    value: "shadow",
    label: "Shadow",
    does: "Decides and stores the decision. No one is told and nothing is shown to closers.",
    changes: "Nothing. The decisions are graded to build the record.",
    raiseWords: "The CRM will decide and log, and change nothing.",
  },
  {
    value: "ask",
    label: "Ask",
    does: "Shows the proposal to the closer or to Billing as one confirmation, with what it will do.",
    changes: "Only what the person confirms. The checks run again when they tap.",
    raiseWords: "Closers will start seeing Whop payments to confirm.",
  },
  {
    value: "automatic",
    label: "Automatic",
    does: "Writes it. A refusal still waits for its notice.",
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

/** Why a kind went back to one tap, as the end of "Went back to one tap: …". */
export const BREAKER_WORDS: Record<BreakerReason, string> = {
  audit_overdue: "a check of an automatic result waited past its deadline",
  wrong_write: "a person found a wrong person, wrong deal or false loss in an automatic result",
  not_my_sale_unanswered: "a closer's “This isn't my sale” went unanswered for a business day",
  certificate_lapsed: "the rule changed, so its clean sample no longer covers it",
};

export const WRONG_FIELD_LABELS: Record<WrongField, string> = {
  person: "Person",
  deal: "Deal",
  amount: "Amount",
  currency: "Currency",
  type: "Type",
  program: "Program",
  credit: "Credit",
  should_abstain: "Should have left it",
  should_write: "Should have written",
  time: "Time",
  method: "Call or text",
  purpose: "Kind of task",
  attendance: "Whether the call happened",
  false_loss: "Not a refusal",
};

/** Fields that send a kind back to one tap when an automatic write is marked wrong on them. */
export const SEVERE_WRONG_FIELDS: readonly WrongField[] = ["person", "deal", "false_loss", "should_abstain"];

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

/** Where a record opens. */
export const RECORD_HREF = {
  deal: (id: string) => `/workspace/opportunities/${id}`,
  meeting: (id: string) => `/workspace/pipeline/meetings/${id}`,
  whopPayment: (id: string) => `/workspace/billing/whop/${id}`,
  payment: (id: string) => `/workspace/billing/${id}`,
} as const;

export const CALL_INSIGHTS_SETTINGS_HREF = "/workspace/pipeline/call-insights?tab=settings";
