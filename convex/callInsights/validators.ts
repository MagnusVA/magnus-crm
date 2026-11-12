import { v, type Infer } from "convex/values";
import { paymentTypeValidator } from "../lib/paymentTypes";

/**
 * Shapes shared by the Call insights tables and functions. Anything holding a
 * quote or a statement is private: it lives on `callInsightRuns`,
 * `resultSuggestionStates` or the eval tables and never on `callInsightFacts`.
 */

/** Bumped whenever the extraction prompt or its JSON schema changes. */
export const PROMPT_VERSION = "p1";
/** Bumped whenever a Jev threshold or a no-show threshold changes. */
export const THRESHOLDS_VERSION = "t1";
export const DEFAULT_EXTRACTION_MODEL = "anthropic/claude-sonnet-5.5";
export const JUDGE_MODEL = "anthropic/claude-opus-5.5";
export const JEV_MODEL = "typesafe/jev-1.13";

export const itemKindValidator = v.union(
  v.literal("objection"),
  v.literal("struggle"),
  v.literal("goal"),
  v.literal("income"),
);

export const resolutionValidator = v.union(
  v.literal("resolved"),
  v.literal("unresolved"),
  v.literal("unknown"),
);

export const incomeScenarioValidator = v.union(
  v.literal("current"),
  v.literal("target"),
);

export const incomePeriodValidator = v.union(
  v.literal("week"),
  v.literal("month"),
  v.literal("year"),
  v.literal("hour"),
  v.literal("per_session"),
  v.literal("one_off"),
  v.literal("point_in_time"),
  v.literal("unknown"),
);

/**
 * What Jev's check decided for one item. `rejected` exists only on the private
 * run: a rejected item is never written to `callInsightFacts`. `restored` is a
 * rejected item an admin put back. `unchecked` means Jev's check is switched
 * off for the tenant.
 */
export const itemCheckValidator = v.union(
  v.literal("confirmed"),
  v.literal("unsure"),
  v.literal("unchecked"),
  v.literal("restored"),
  v.literal("rejected"),
);
export const publishedItemCheckValidator = v.union(
  v.literal("confirmed"),
  v.literal("unsure"),
  v.literal("unchecked"),
  v.literal("restored"),
);

/** A quote Magnus found in the transcript. The time and speaker come from the transcript line, never the model. */
export const quoteValidator = v.object({
  quote: v.string(),
  lineIndex: v.number(),
  atSeconds: v.number(),
  speaker: v.union(
    v.literal("Closer"),
    v.literal("Prospect"),
    v.literal("Other"),
  ),
});
export type FoundQuote = Infer<typeof quoteValidator>;

/** One extracted item after code validation, with Jev's check once it ran. Private. */
export const insightItemValidator = v.object({
  /** Stable within the run: `${kind}:${n}`. */
  key: v.string(),
  kind: itemKindValidator,
  /** A key of the kind's category table in lib/callInsights/taxonomy.ts. */
  category: v.string(),
  /** One line of plain English written by the model. */
  statement: v.string(),
  /** The prospect's exact words, in the language they were spoken. */
  quote: v.string(),
  lineIndex: v.number(),
  atSeconds: v.number(),
  // Objections.
  resolution: v.optional(resolutionValidator),
  resolutionQuote: v.optional(v.string()),
  resolutionLineIndex: v.optional(v.number()),
  // Goals. The deadline is kept as said ("by summer"), never turned into a date.
  deadline: v.optional(v.string()),
  // Income, and a goal's target amount.
  scenario: v.optional(incomeScenarioValidator),
  period: v.optional(incomePeriodValidator),
  /** ISO code. Absent when no currency was said. */
  currency: v.optional(v.string()),
  /** True when the prospect said only "dollars" and Magnus assumed USD. */
  currencyAssumed: v.optional(v.boolean()),
  minMinor: v.optional(v.number()),
  /** Absent with `minMinor` set means "at least". */
  maxMinor: v.optional(v.number()),
  monthlyMinMinor: v.optional(v.number()),
  monthlyMaxMinor: v.optional(v.number()),
  /** A band key from `incomeBandFor`, or one of INCOME_BAND_SPECIAL. */
  band: v.optional(v.string()),
  // Jev's check.
  check: itemCheckValidator,
  /** Jev's 0 to 1 answer to "do these lines say this?". */
  score: v.optional(v.number()),
  resolutionScore: v.optional(v.number()),
});
export type InsightItem = Infer<typeof insightItemValidator>;

/** Why code dropped items the model proposed, as counts. No text. */
export const droppedCountsValidator = v.object({
  quoteNotFound: v.number(),
  notProspect: v.number(),
  amountNotInQuote: v.number(),
  badCategory: v.number(),
  cardNumber: v.number(),
  overLimit: v.number(),
});

/** Everything code measures from a transcript for the attendance read. Numbers and enums only. */
export const attendanceMeasuresValidator = v.object({
  lineCount: v.number(),
  /** Distinct speaker keys (email, else display name). */
  speakerKeys: v.number(),
  closerOnly: v.boolean(),
  closerLines: v.number(),
  closerWordsAfterStart: v.number(),
  closerLinesAfterStart: v.number(),
  otherWords: v.number(),
  otherLines: v.number(),
  /** One unknown speaker with no email, at most 15 words in at most 3 lines. */
  otherIsOneShortUnknown: v.boolean(),
  answerLikePairs: v.number(),
  longestGapSeconds: v.number(),
  /** Recording start and end, in seconds from the Calendly scheduled start. Negative is early. */
  startOffsetSeconds: v.number(),
  endOffsetSeconds: v.number(),
  lengthSeconds: v.number(),
  recorderIsAssignedCloser: v.boolean(),
  matchStrong: v.boolean(),
  /** Other recordings by the same recorder from 30 minutes before to 60 minutes after. */
  otherRecordingsWithLines: v.number(),
  otherRecordingsAny: v.number(),
  /** True when the dropped-recording trace covers the whole window. */
  traceCoversWindow: v.boolean(),
  newerBooking: v.boolean(),
  slotEndedAt: v.number(),
  /**
   * Seconds from the scheduled start to the first line of a speaker proven to
   * be the prospect (email matched to an invitee). Absent when no such line.
   */
  prospectFirstLineOffsetSeconds: v.optional(v.number()),
  /** Seconds from the scheduled start to the first line not spoken by the closer. */
  firstOtherLineOffsetSeconds: v.optional(v.number()),
});
export type AttendanceMeasures = Infer<typeof attendanceMeasuresValidator>;

export const attendanceReadingValidator = v.union(
  v.literal("absent"),
  v.literal("present"),
  v.literal("not_sales_call"),
  v.literal("unclear"),
);

/** Claude's attendance block after code checked every quote against the transcript. Private. */
export const attendanceEvidenceValidator = v.object({
  reading: attendanceReadingValidator,
  waiting: v.array(quoteValidator),
  leaving: v.array(quoteValidator),
  triedToReach: v.array(quoteValidator),
  someoneThere: v.array(quoteValidator),
  secondPerson: v.array(quoteValidator),
  notSalesCall: v.array(quoteValidator),
  /** What the closer's words suggest for the no-show form's reason. */
  suggestedReason: v.optional(
    v.union(
      v.literal("no_response"),
      v.literal("late_cancel"),
      v.literal("technical_issues"),
    ),
  ),
});
export type AttendanceEvidence = Infer<typeof attendanceEvidenceValidator>;

/** Jev's answer to one choice question on one reading. */
export const jevChoiceValidator = v.object({
  choice: v.string(),
  confidence: v.optional(v.number()),
});

/**
 * Jev's own reading of the call, asked with Second opinion's questions and
 * stored on the Call insights run, never as a `secondOpinions` row. Each
 * question is read twice: with Fathom's summary and without.
 */
export const earlyReadingValidator = v.object({
  attendance: v.optional(
    v.object({
      withSummary: v.optional(jevChoiceValidator),
      withoutSummary: v.optional(jevChoiceValidator),
    }),
  ),
  ending: v.optional(
    v.object({
      withSummary: v.optional(jevChoiceValidator),
      withoutSummary: v.optional(jevChoiceValidator),
    }),
  ),
  /** Jev's 0 to 1 answer on the cited lines for the proposed result. */
  resultCheck: v.optional(v.number()),
  /** True when a request failed and its answer is missing. */
  incomplete: v.boolean(),
});
export type EarlyReading = Infer<typeof earlyReadingValidator>;

export const suggestionKindValidator = v.union(
  v.literal("paid"),
  v.literal("promised"),
  v.literal("call_back"),
  v.literal("lost"),
  v.literal("no_show"),
  v.literal("no_decision"),
  v.literal("empty_recording"),
);
export const suggestionTierValidator = v.union(
  v.literal("ready"),
  v.literal("check"),
  v.literal("unconfirmed"),
);
export const noShowTierValidator = v.union(
  v.literal("none"),
  v.literal("empty"),
  v.literal("check"),
  v.literal("certain"),
  v.literal("review"),
  v.literal("unconfirmed"),
);
export const noShowReasonValidator = v.union(
  v.literal("no_response"),
  v.literal("late_cancel"),
  v.literal("technical_issues"),
  v.literal("other"),
);
export const lossCategoryValidator = v.union(
  v.literal("not_a_fit"),
  v.literal("price"),
  v.literal("timing"),
  v.literal("went_quiet"),
  v.literal("other"),
);

/** The values a suggestion may put in an existing form. Private. */
export const suggestionValuesValidator = v.object({
  amountMinor: v.optional(v.number()),
  currency: v.optional(v.string()),
  /** True when only "dollars" was said and USD was assumed. */
  currencyAssumed: v.optional(v.boolean()),
  paymentType: v.optional(paymentTypeValidator),
  /** Set only when the program heard matches one of the tenant's programs exactly. */
  programId: v.optional(v.id("tenantPrograms")),
  /** Epoch ms, always in the future when the suggestion was built. */
  callbackAt: v.optional(v.number()),
  contactMethod: v.optional(v.union(v.literal("call"), v.literal("text"))),
  lossCategory: v.optional(lossCategoryValidator),
  noShowReason: v.optional(noShowReasonValidator),
});
export type SuggestionValues = Infer<typeof suggestionValuesValidator>;

/** What Claude said about how the call ended, after code checks. Private. */
export const resultEvidenceValidator = v.object({
  kind: v.union(
    v.literal("paid"),
    v.literal("promised"),
    v.literal("call_back"),
    v.literal("lost"),
    v.literal("no_decision"),
    v.literal("none"),
  ),
  /** The quotes backing the result, in the order the card shows them. */
  quotes: v.array(v.object({ label: v.string(), ...quoteValidator.fields })),
  values: suggestionValuesValidator,
  /** Program name as heard, kept for the card when it matches no program. */
  programHeard: v.optional(v.string()),
  /** Every code check on the values passed. False means label and quote only. */
  codeChecksPassed: v.boolean(),
  /** Codes for the checks that failed, such as `amount_not_in_quote`. */
  failedChecks: v.array(v.string()),
});
export type ResultEvidence = Infer<typeof resultEvidenceValidator>;

/** The no-show tier a recording would get at each candidate wait, in minutes. */
export const shadowTiersValidator = v.object({
  wait5: noShowTierValidator,
  wait7: noShowTierValidator,
  wait10: noShowTierValidator,
});

export const runStatusValidator = v.union(
  v.literal("queued"),
  // Admitted later: the month's cap has no room for this run's reservation.
  v.literal("waiting"),
  v.literal("running"),
  // Claude answered; Jev's requests are in flight or being retried.
  v.literal("checking"),
  v.literal("answered"),
  v.literal("failed"),
  v.literal("skipped"),
);
export type RunStatus = Infer<typeof runStatusValidator>;

export const runReasonValidator = v.union(
  v.literal("disabled"),
  v.literal("cap_reached"),
  v.literal("no_transcript"),
  v.literal("other_prospect"),
  v.literal("no_prospect_speech"),
  v.literal("not_sales_call"),
  v.literal("input_too_large"),
  v.literal("format_changed"),
  v.literal("refused"),
  v.literal("upstream_error"),
  v.literal("rejected"),
  v.literal("recording_moved"),
  v.literal("superseded"),
  v.literal("lease_expired"),
  v.literal("canceled"),
);
export type RunReason = Infer<typeof runReasonValidator>;

export const runTriggerValidator = v.union(
  v.literal("recording_matched"),
  v.literal("backfill"),
  v.literal("rerun"),
  v.literal("read_again"),
  v.literal("sweep"),
  v.literal("eval"),
);

export const receiptOriginValidator = v.union(
  v.literal("claude"),
  v.literal("jev_item"),
  v.literal("jev_reading"),
  v.literal("jev_result"),
  v.literal("opus"),
);

/** One paid request: what was reserved before it was sent and what it cost. */
export const receiptValidator = v.object({
  /** Unique within the run, such as `claude:2` or `jev_item:objection:0`. */
  key: v.string(),
  origin: receiptOriginValidator,
  /** The UTC month the reservation was booked in, `YYYY-MM`. */
  monthKey: v.string(),
  pool: v.union(v.literal("serve"), v.literal("eval")),
  reservedMicroUsd: v.number(),
  /** Set when settled. A request whose cost never came back settles at the full reservation. */
  spentMicroUsd: v.optional(v.number()),
  settledAt: v.optional(v.number()),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  gatewayRequestId: v.optional(v.string()),
});
export type Receipt = Infer<typeof receiptValidator>;

/** The versions one reading was made with. Two readings compare only when these match. */
export const runConfigValidator = v.object({
  model: v.string(),
  promptVersion: v.string(),
  taxonomyVersion: v.string(),
  thresholdsVersion: v.string(),
  itemCheck: v.boolean(),
});
export type RunConfig = Infer<typeof runConfigValidator>;

export const callInsightsModeValidator = v.union(
  v.literal("off"),
  // Calls are read; only owners and admins see the result.
  v.literal("shadow"),
  // Closers also see What they said on their own calls.
  v.literal("on"),
);

/** `tenants.callInsights`. Absent means off. Never written by Second opinion's settings. */
export const callInsightsSettingsValidator = v.object({
  mode: callInsightsModeValidator,
  /**
   * Suggested results. `hidden` computes and grades them without showing them
   * on a meeting (the hidden trial); `on` shows them to everyone who may see
   * the meeting.
   */
  suggestions: v.union(v.literal("off"), v.literal("hidden"), v.literal("on")),
  /** Fill the amount on a payment suggestion. Off means the person types it. */
  amountPrefill: v.boolean(),
  /** Show the one-confirm "Certain" no-show. Off means a Certain reads as Review. */
  noShowCertain: v.boolean(),
  /** Minutes a closer must have waited before a no-show can be Certain. Unset until the wait study decides it. */
  noShowWaitMinutes: v.optional(v.number()),
  /** The one monthly limit for every model call, Second opinion included. */
  monthlyCapUsd: v.number(),
  /** The most automated evals may spend a month, inside the limit above. */
  evalMonthlyUsd: v.number(),
  /** Jev checks each item's meaning. Off publishes items as `unchecked`. */
  itemCheck: v.boolean(),
  model: v.string(),
  /** Calls matched before this are read only by a backfill job. */
  enabledAt: v.number(),
  changedAt: v.number(),
  changedByUserId: v.id("users"),
});
export type CallInsightsSettings = Infer<typeof callInsightsSettingsValidator>;

/** The optional argument a result save carries when it came from a suggestion. */
export const fromSuggestionValidator = v.object({
  stateId: v.id("resultSuggestionStates"),
  revision: v.number(),
  /** Names of the prefilled fields the person changed. Never values. */
  changedFields: v.optional(v.array(v.string())),
});
export type FromSuggestion = Infer<typeof fromSuggestionValidator>;
