import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  attendanceEvidenceValidator,
  attendanceMeasuresValidator,
  droppedCountsValidator,
  earlyReadingValidator,
  incomePeriodValidator,
  incomeScenarioValidator,
  insightItemValidator,
  itemKindValidator,
  noShowTierValidator,
  publishedItemCheckValidator,
  quoteValidator,
  receiptValidator,
  resolutionValidator,
  resultEvidenceValidator,
  runConfigValidator,
  runReasonValidator,
  runStatusValidator,
  runTriggerValidator,
  shadowTiersValidator,
  suggestionKindValidator,
  suggestionTierValidator,
  suggestionValuesValidator,
} from "./validators";

/**
 * Call insights (docs/reviews/call-insights-architecture.html). Prospect words
 * live only in `callInsightRuns`, `resultSuggestionStates` and the eval label
 * tables; they are deleted when the transcript expires. `callInsightFacts`
 * holds categories, numbers and enums only.
 */
export const callInsightTables = {
  /**
   * One reading of one recording: a serving read (`generation` 1, 2, …) or an
   * eval read. Holds everything the models said and what each request cost.
   * Private: never synced, never logged.
   */
  callInsightRuns: defineTable({
    tenantId: v.id("tenants"),
    recordingId: v.id("callRecordings"),
    meetingId: v.id("meetings"),
    purpose: v.union(v.literal("serve"), v.literal("eval")),
    // Eval reads: a candidate extraction, Opus grading it, or Opus's blind list.
    evalRole: v.optional(
      v.union(
        v.literal("candidate"),
        v.literal("judge"),
        v.literal("inventory"),
      ),
    ),
    evalCaseId: v.optional(v.id("callInsightEvalCases")),
    jobId: v.optional(v.id("callInsightJobs")),
    /** Serving reads count up from 1 per recording. Eval reads use 0. */
    generation: v.number(),
    /** One run per key per tenant, so a repeated hook or job can't read twice. */
    inputKey: v.string(),
    trigger: runTriggerValidator,
    /** `attendance_only`: only the closer spoke, so only attendance is read. */
    kind: v.union(v.literal("full"), v.literal("attendance_only")),
    status: runStatusValidator,
    reason: v.optional(runReasonValidator),
    /** Claims so far. `begin` raises it; at most 4. */
    attempt: v.number(),
    /** Fresh per claim. A worker holding an old token can't publish. */
    claimToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    /** When a queued or waiting run may be claimed again. */
    nextAttemptAt: v.optional(v.number()),
    /** Times the Jev stage was retried alone. At most 3. */
    checkRetries: v.optional(v.number()),
    config: runConfigValidator,
    // What Claude said, after code validation. Cleared of text at transcript expiry.
    items: v.optional(v.array(insightItemValidator)),
    dropped: v.optional(droppedCountsValidator),
    /** Claude's main blocker before Jev's check, kept to measure agreement. */
    primaryBlockerExtracted: v.optional(v.string()),
    /** The main blocker among the items that survived. */
    primaryBlocker: v.optional(v.string()),
    speakerUncertain: v.optional(v.boolean()),
    result: v.optional(resultEvidenceValidator),
    attendance: v.optional(attendanceEvidenceValidator),
    measures: v.optional(attendanceMeasuresValidator),
    earlyReading: v.optional(earlyReadingValidator),
    // Eval reads by Opus: enums and line numbers only, as JSON text.
    judgeOutput: v.optional(v.string()),
    receipts: v.array(receiptValidator),
    quotesExpireAt: v.optional(v.number()),
    quotesPurgedAt: v.optional(v.number()),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_tenantId_and_inputKey", ["tenantId", "inputKey"])
    .index("by_recordingId_and_purpose_and_generation", [
      "recordingId",
      "purpose",
      "generation",
    ])
    .index("by_status_and_leaseUntil", ["status", "leaseUntil"])
    .index("by_status_and_nextAttemptAt", ["status", "nextAttemptAt"])
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
    .index("by_jobId", ["jobId"])
    .index("by_evalCaseId", ["evalCaseId"])
    .index("by_quotesExpireAt", ["quotesExpireAt"]),

  /**
   * What reports and cards count: one permanent `call` header per matched
   * recording, read or not, plus one row per published item. No quote,
   * statement, name or free text in any column. The header is never deleted;
   * `active: false` is its tombstone.
   */
  callInsightFacts: defineTable(
    v.union(
      v.object({
        kind: v.literal("call"),
        tenantId: v.id("tenants"),
        recordingId: v.id("callRecordings"),
        meetingId: v.id("meetings"),
        active: v.boolean(),
        /** Goes up with every publication. Item rows carry the same number. */
        publicationRevision: v.number(),
        /** The latest attempt, whatever the last successful publication was. */
        latestStatus: runStatusValidator,
        reasonCode: v.optional(runReasonValidator),
        latestRunId: v.optional(v.id("callInsightRuns")),
        publishedRunId: v.optional(v.id("callInsightRuns")),
        publishedGeneration: v.optional(v.number()),
        /** Item rows this revision must have before a report counts the call. */
        expectedItemCount: v.number(),
        rejectedCount: v.optional(v.number()),
        primaryBlocker: v.optional(v.string()),
        speakerUncertain: v.optional(v.boolean()),
        readKind: v.optional(
          v.union(v.literal("full"), v.literal("attendance_only")),
        ),
        model: v.optional(v.string()),
        promptVersion: v.optional(v.string()),
        thresholdsVersion: v.optional(v.string()),
        taxonomyVersion: v.optional(v.string()),
        itemCheck: v.optional(v.boolean()),
        analyzedAt: v.optional(v.number()),
        /** The meeting's scheduled start, for report ranges. */
        scheduledAt: v.number(),
        // Wait study: numbers only, kept after the transcript expires.
        startOffsetSeconds: v.optional(v.number()),
        endOffsetSeconds: v.optional(v.number()),
        prospectFirstLineOffsetSeconds: v.optional(v.number()),
        firstOtherLineOffsetSeconds: v.optional(v.number()),
        /** How the prospect's first line was identified. */
        prospectIdentity: v.optional(
          v.union(
            v.literal("email_matched"),
            v.literal("closer_confirmed"),
            v.literal("fallback"),
            v.literal("unknown"),
          ),
        ),
        /** An admin's answer for a call whose arrival the recording can't show. */
        confirmedArrivalOffsetSeconds: v.optional(v.number()),
        noShowTier: v.optional(noShowTierValidator),
        shadowTiers: v.optional(shadowTiersValidator),
        quotesPurgedAt: v.optional(v.number()),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
      v.object({
        kind: itemKindValidator,
        tenantId: v.id("tenants"),
        recordingId: v.id("callRecordings"),
        meetingId: v.id("meetings"),
        publicationRevision: v.number(),
        /** The run item's key, such as `objection:2`. */
        key: v.string(),
        category: v.string(),
        isPrimary: v.optional(v.boolean()),
        resolution: v.optional(resolutionValidator),
        scenario: v.optional(incomeScenarioValidator),
        period: v.optional(incomePeriodValidator),
        currency: v.optional(v.string()),
        currencyAssumed: v.optional(v.boolean()),
        minMinor: v.optional(v.number()),
        maxMinor: v.optional(v.number()),
        monthlyMinMinor: v.optional(v.number()),
        monthlyMaxMinor: v.optional(v.number()),
        band: v.optional(v.string()),
        check: publishedItemCheckValidator,
        scheduledAt: v.number(),
      }),
    ),
  )
    .index("by_recordingId_and_kind", ["recordingId", "kind"])
    .index("by_meetingId_and_kind", ["meetingId", "kind"])
    .index("by_tenantId_and_kind_and_scheduledAt", [
      "tenantId",
      "kind",
      "scheduledAt",
    ])
    .index("by_tenantId_and_kind_and_latestStatus", [
      "tenantId",
      "kind",
      "latestStatus",
    ]),

  /**
   * One row per tenant per UTC month. Every paid request reserves its maximum
   * cost here before it is sent and settles to its real cost afterwards, so
   * two runs can't both take the last dollar.
   */
  callInsightBudgets: defineTable({
    tenantId: v.id("tenants"),
    /** `YYYY-MM`, the same UTC month Second opinion's cap uses. */
    monthKey: v.string(),
    reservedMicroUsd: v.number(),
    spentMicroUsd: v.number(),
    // The part of the two numbers above that automated evals account for.
    evalReservedMicroUsd: v.number(),
    evalSpentMicroUsd: v.number(),
    updatedAt: v.number(),
  }).index("by_tenantId_and_monthKey", ["tenantId", "monthKey"]),

  /** A batch an admin approved: reading older calls, or an eval run. */
  callInsightJobs: defineTable({
    tenantId: v.id("tenants"),
    kind: v.union(
      v.literal("backfill"),
      v.literal("rerun"),
      v.literal("eval_judge"),
      v.literal("eval_regression"),
    ),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("canceled"),
    ),
    /** The most this job may spend in its lifetime. */
    ceilingMicroUsd: v.number(),
    spentMicroUsd: v.number(),
    estimateMicroUsd: v.number(),
    total: v.number(),
    done: v.number(),
    failed: v.number(),
    skipped: v.number(),
    /** Eval jobs: the campaign whose cases the job reads. */
    campaign: v.optional(v.string()),
    /** Regression jobs: the configuration being tried. */
    candidateConfig: v.optional(runConfigValidator),
    createdByUserId: v.id("users"),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
    .index("by_status_and_createdAt", ["status", "createdAt"]),

  callInsightJobItems: defineTable({
    tenantId: v.id("tenants"),
    jobId: v.id("callInsightJobs"),
    recordingId: v.id("callRecordings"),
    /** Soonest transcript expiry first. */
    order: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("skipped"),
      v.literal("canceled"),
    ),
    runId: v.optional(v.id("callInsightRuns")),
  })
    .index("by_jobId_and_status_and_order", ["jobId", "status", "order"])
    .index("by_tenantId_and_jobId", ["tenantId", "jobId"])
    .index("by_runId", ["runId"]),

  /**
   * One row per item Jev rejected. An admin either restores the item ("Claude
   * was right") or leaves it hidden ("Jev was right"). History is kept.
   */
  callInsightItemReviews: defineTable({
    tenantId: v.id("tenants"),
    recordingId: v.id("callRecordings"),
    meetingId: v.id("meetings"),
    runId: v.id("callInsightRuns"),
    itemKey: v.string(),
    itemKind: itemKindValidator,
    category: v.string(),
    state: v.union(
      v.literal("open"),
      v.literal("restored"),
      v.literal("dismissed"),
      v.literal("superseded"),
    ),
    decidedByUserId: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_runId_and_itemKey", ["runId", "itemKey"])
    .index("by_tenantId_and_state_and_createdAt", [
      "tenantId",
      "state",
      "createdAt",
    ])
    .index("by_recordingId", ["recordingId"]),

  /**
   * The result a call's reading proposes for a meeting nobody recorded yet.
   * One row per meeting, replaced when the call is read again. Private: holds
   * quotes and form values, and is cleared of them at transcript expiry.
   */
  resultSuggestionStates: defineTable({
    tenantId: v.id("tenants"),
    meetingId: v.id("meetings"),
    recordingId: v.id("callRecordings"),
    runId: v.id("callInsightRuns"),
    /** Goes up whenever the suggestion's kind, tier or values change. */
    revision: v.number(),
    kind: suggestionKindValidator,
    tier: suggestionTierValidator,
    noShowTier: v.optional(noShowTierValidator),
    /**
     * Seconds from the scheduled start to the recording's end: how long the
     * closer waited. Kept so a Certain no-show can be held to the wait the
     * tenant requires now, not the one in force when the call was read.
     */
    waitedSeconds: v.optional(v.number()),
    values: suggestionValuesValidator,
    quotes: v.array(v.object({ label: v.string(), ...quoteValidator.fields })),
    /** What each reader concluded, as enums, for the card's "Check this" line. */
    claudeReading: v.optional(v.string()),
    jevReading: v.optional(v.string()),
    /** Codes for why nothing is filled, such as `amount_not_in_quote`. */
    notes: v.array(v.string()),
    // Exposure and use.
    shownAt: v.optional(v.number()),
    shownToUserId: v.optional(v.id("users")),
    usedAt: v.optional(v.number()),
    usedByUserId: v.optional(v.id("users")),
    changedFields: v.optional(v.array(v.string())),
    proofWaived: v.optional(v.boolean()),
    paymentId: v.optional(v.id("paymentRecords")),
    // How the result a person saved compared, filled after the save.
    savedKind: v.optional(v.string()),
    comparison: v.optional(
      v.union(
        v.literal("same_result"),
        v.literal("different_result"),
        v.literal("same_result_different_values"),
      ),
    ),
    comparedAt: v.optional(v.number()),
    quotesPurgedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_meetingId", ["meetingId"])
    .index("by_recordingId", ["recordingId"])
    .index("by_tenantId_and_comparedAt", ["tenantId", "comparedAt"])
    .index("by_tenantId_and_kind_and_createdAt", [
      "tenantId",
      "kind",
      "createdAt",
    ]),

  /**
   * One call in a quality campaign. Text-free. The admin's labels are
   * committed (`labelsCommittedAt`) before any judge verdict on the case can
   * be read.
   */
  callInsightEvalCases: defineTable({
    tenantId: v.id("tenants"),
    recordingId: v.id("callRecordings"),
    meetingId: v.id("meetings"),
    campaign: v.string(),
    split: v.union(
      v.literal("dev"),
      v.literal("calib"),
      v.literal("holdout"),
      v.literal("drift_random"),
      v.literal("drift_risk"),
    ),
    /** The person behind the call, so every call of one person shares a split. */
    groupKey: v.string(),
    status: v.union(
      v.literal("to_read"),
      // The admin committed their own list of items, made before seeing any model answer.
      v.literal("list_committed"),
      // The admin graded the extractor's items and committed the labels.
      v.literal("labels_committed"),
      v.literal("closed"),
    ),
    labelRevision: v.number(),
    listCommittedAt: v.optional(v.number()),
    labelsCommittedAt: v.optional(v.number()),
    labelledByUserId: v.optional(v.id("users")),
    /** The serving or eval run whose items were graded. */
    candidateRunId: v.optional(v.id("callInsightRuns")),
    inventoryRunId: v.optional(v.id("callInsightRuns")),
    judgeRunId: v.optional(v.id("callInsightRuns")),
    /** The stability re-run: the same candidates in reverse order. */
    judgeRerunId: v.optional(v.id("callInsightRuns")),
    candidateConfig: v.optional(runConfigValidator),
    /** True when insights or a suggestion were visible before the result was saved. */
    exposedBeforeResult: v.optional(v.boolean()),
    /** Labels made after a judge disagreement was seen never count for calibration. */
    judgeExposed: v.optional(v.boolean()),
    /** Cases and their labels are deleted at the campaign's close or here, whichever is first. */
    purgeAt: v.number(),
    createdByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
  })
    .index("by_tenantId_and_campaign_and_split", [
      "tenantId",
      "campaign",
      "split",
    ])
    .index("by_tenantId_and_campaign_and_status", [
      "tenantId",
      "campaign",
      "status",
    ])
    .index("by_recordingId_and_campaign", ["recordingId", "campaign"])
    .index("by_purgeAt", ["purgeAt"]),

  /**
   * One labelled item of one eval case: an item the extractor produced, one
   * the admin listed themselves, one from Opus's blind list, or a planted
   * defect. Typed values and line numbers only; no quote and no free text.
   */
  callInsightEvalLabels: defineTable({
    tenantId: v.id("tenants"),
    caseId: v.id("callInsightEvalCases"),
    source: v.union(
      v.literal("extractor"),
      v.literal("admin"),
      v.literal("inventory"),
      v.literal("planted"),
    ),
    /** What the label is about. `result` and `attendance` are the suggested result and the attendance read. */
    itemClass: v.union(
      itemKindValidator,
      v.literal("result"),
      v.literal("attendance"),
    ),
    /** The run item's key for extractor and planted labels. */
    itemKey: v.optional(v.string()),
    category: v.optional(v.string()),
    lineStart: v.optional(v.number()),
    lineEnd: v.optional(v.number()),
    // Typed values, as on the run item or the suggestion.
    resolution: v.optional(resolutionValidator),
    scenario: v.optional(incomeScenarioValidator),
    period: v.optional(incomePeriodValidator),
    currency: v.optional(v.string()),
    minMinor: v.optional(v.number()),
    maxMinor: v.optional(v.number()),
    resultKind: v.optional(suggestionKindValidator),
    resultTier: v.optional(suggestionTierValidator),
    resultValues: v.optional(suggestionValuesValidator),
    noShowTier: v.optional(noShowTierValidator),
    /** Planted labels: which defect was planted. */
    plantedDefect: v.optional(
      v.union(
        v.literal("invented_income"),
        v.literal("swapped_amount"),
        v.literal("wrong_currency"),
        v.literal("promise_as_paid"),
        v.literal("wrong_category"),
        v.literal("unsupported_resolution"),
      ),
    ),
    /** The admin's verdict on an extractor item, or `right` for their own items. */
    adminVerdict: v.optional(
      v.union(v.literal("right"), v.literal("wrong"), v.literal("unsure")),
    ),
    /** Which fields the admin marked wrong, by name. */
    wrongFields: v.optional(v.array(v.string())),
    /** For an admin or inventory item: the extractor label it matches, if any. */
    matchedLabelId: v.optional(v.id("callInsightEvalLabels")),
    /** Opus's grade of an extractor or planted item. Readable only after the case's labels are committed. */
    judgeVerdict: v.optional(
      v.union(
        v.literal("supported"),
        v.literal("contradicted"),
        v.literal("insufficient"),
      ),
    ),
    judgeWrongFields: v.optional(v.array(v.string())),
    judgeLines: v.optional(v.array(v.number())),
    /** The same grade from the reversed-order re-run. */
    judgeRerunVerdict: v.optional(
      v.union(
        v.literal("supported"),
        v.literal("contradicted"),
        v.literal("insufficient"),
      ),
    ),
    labelRevision: v.number(),
    createdAt: v.number(),
  })
    .index("by_caseId_and_source", ["caseId", "source"])
    .index("by_tenantId_and_caseId", ["tenantId", "caseId"]),

  /** One evaluation result. Numbers, versions and pass or fail per bar. Kept. */
  callInsightEvalReports: defineTable({
    tenantId: v.id("tenants"),
    kind: v.union(
      v.literal("quality"),
      v.literal("judge_calibration"),
      v.literal("regression"),
      v.literal("drift"),
      v.literal("suggestions"),
      v.literal("no_show"),
      v.literal("wait_study"),
    ),
    campaign: v.optional(v.string()),
    split: v.optional(v.string()),
    config: v.optional(runConfigValidator),
    judgeModel: v.optional(v.string()),
    bars: v.array(
      v.object({
        key: v.string(),
        /** Eligible cases counted, and how many of them were wrong. */
        n: v.number(),
        wrong: v.number(),
        /** Distinct calls behind `n`. */
        calls: v.number(),
        floor: v.number(),
        /** The rule in words a report can print, such as "at most 3 wrong in 60". */
        rule: v.string(),
        /** Exact one-sided 95% lower bound on the share right, 0 to 1. */
        lowerBound: v.optional(v.number()),
        result: v.union(
          v.literal("pass"),
          v.literal("fail"),
          v.literal("inconclusive"),
        ),
      }),
    ),
    spentMicroUsd: v.number(),
    jobId: v.optional(v.id("callInsightJobs")),
    createdByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
  }).index("by_tenantId_and_kind_and_createdAt", [
    "tenantId",
    "kind",
    "createdAt",
  ]),
};
