import { defineTable } from "convex/server";
import { v } from "convex/values";
import { runTriggerValidator } from "../callInsights/validators";
import { paymentTypeValidator } from "../lib/paymentTypes";
import { dealPositionValidator } from "../payments/schema";

export const automationKindValidator = v.union(
  v.literal("payment_win"),
  v.literal("additional_payment"),
  // The call kinds, read from recorded calls (phase 3).
  v.literal("call_back"),
  v.literal("payment_owed"),
  v.literal("refusal_loss"),
);

export const automationModeValidator = v.union(
  v.literal("off"),
  v.literal("shadow"),
  v.literal("ask"),
  v.literal("automatic"),
);

/** What setKindMode accepts. "automatic" is written only by promoteKind. */
export const settableModeValidator = v.union(v.literal("off"), v.literal("shadow"), v.literal("ask"));

/** The paid-on-call alert is not an automation kind: it is never automatic. */
export const settableAlertModeValidator = v.union(v.literal("off"), v.literal("shadow"), v.literal("on"));

export const decisionModeValidator = v.union(v.literal("shadow"), v.literal("ask"), v.literal("automatic"));

export const decisionKindValidator = v.union(
  ...automationKindValidator.members,
  v.literal("paid_on_call_alert"),
);

export const decisionStateValidator = v.union(
  v.literal("shadow"), // Stored only.
  v.literal("needs_person"), // The rule abstains. A person picks in Billing.
  v.literal("ready"), // One-tap confirm, waiting on noticeUserId or Billing.
  v.literal("applied"), // A person confirmed it. The row is the apply receipt.
  v.literal("stopped"),
  v.literal("superseded"),
  v.literal("blocked"),
  v.literal("undone"),
  v.literal("corrected"),
  v.literal("notice"), // An automatic refusal waiting on its notice.
);

export const stopCodeValidator = v.union(
  v.literal("human_result"),
  v.literal("paused"),
  v.literal("kind_lowered"),
  v.literal("person_stop"),
  v.literal("merged"),
  v.literal("adverse"),
  v.literal("input_changed"),
  v.literal("deal_closed"),
  v.literal("payment_found"),
  v.literal("recording_moved"),
  v.literal("transcript_gone"),
  v.literal("closer_changed"),
  v.literal("late_wakeup"),
  v.literal("newer_meeting"),
  v.literal("breaker"),
  v.literal("certificate_lapsed"),
);

export const confirmRouteValidator = v.union(
  v.literal("meeting"),
  v.literal("reminder"),
  v.literal("billing"),
);

export const appliedViaValidator = v.union(
  v.literal("billing"),
  v.literal("meeting_attended"),
  v.literal("meeting_no_show"),
  v.literal("reminder"),
  v.literal("side_deal"),
  v.literal("meeting_confirm"),
  v.literal("automatic"),
);

// Every provider payment review reason except "ready", plus automation-only gates.
export const automationGateValidator = v.union(
  v.literal("not_paid"),
  v.literal("unknown_payer"),
  v.literal("no_payer_email"),
  v.literal("phone_only"),
  v.literal("ambiguous_person"),
  v.literal("phone_conflict"),
  v.literal("no_open_deal"),
  v.literal("several_open_deals"),
  v.literal("qualified_only"),
  v.literal("side_deal"),
  v.literal("lost_by_person"),
  v.literal("system_loss"),
  v.literal("won_deal_no_membership"),
  v.literal("deal_newer_than_payment"),
  v.literal("stale_payment"),
  v.literal("historical"),
  v.literal("dismissed"),
  v.literal("unmapped_product"),
  v.literal("multi_item"),
  v.literal("financing"),
  v.literal("renewal_unbound"),
  v.literal("unbound_membership"),
  v.literal("unknown_billing_reason"),
  v.literal("unsupported_currency"),
  v.literal("unlinked_manual_payment"),
  v.literal("amount_mismatch"),
  v.literal("no_closer"),
  v.literal("credit_conflict"),
  v.literal("capacity_hold"),
  v.literal("binding_conflict"),
  v.literal("program_mismatch"),
  v.literal("read_limit"),
  v.literal("connection_mismatch"),
  v.literal("refund"),
  v.literal("dispute"),
  v.literal("not_my_sale"),
  v.literal("covers_several"),
  v.literal("excluded_wrong_match"),
  v.literal("task_closer_conflict"),
  v.literal("stood_down"),
  // Call kinds. (A) marks a gate that blocks only the automatic write.
  v.literal("not_whole_call"),
  v.literal("speakers_unclear"),
  v.literal("recording_too_long"),
  v.literal("weak_recording_match"),
  v.literal("other_prospect"),
  v.literal("transcript_gone"),
  v.literal("slot_not_over"),
  v.literal("checks_incomplete"),
  v.literal("checks_disagree"),
  v.literal("code_checks_failed"),
  v.literal("result_mismatch"),
  v.literal("no_final_statement"),
  v.literal("not_prospect_words"),
  v.literal("closer_disqualified"),
  v.literal("not_final_refusal"),
  v.literal("no_contact_method"),
  v.literal("no_time"),
  v.literal("time_past"),
  v.literal("no_amount"),
  v.literal("no_currency"),
  v.literal("meeting_not_open"),
  v.literal("deal_not_open"),
  v.literal("open_task"),
  v.literal("newer_meeting"),
  v.literal("payment_exists"),
  v.literal("unresolved_payment"),
  v.literal("late_reading"), // (A)
  v.literal("not_fresh_read"), // (A)
  v.literal("out_of_scope"), // (A)
  v.literal("mapping_held"), // (A)
  v.literal("whop_stale"), // (A)
  // Payment kinds: a call refusal closed the deal; a person confirms.
  v.literal("call_refusal_loss"),
);

// The phase 2 payment proposal. It stays untagged, so its rows still validate.
export const paymentProposalValidator = v.object({
  amountMinor: v.number(),
  currency: v.string(),
  paymentType: paymentTypeValidator,
  programId: v.id("tenantPrograms"),
  attributedCloserId: v.id("users"),
  // The closer's own reminder when confirming through the reminder route.
  completesFollowUpId: v.optional(v.id("followUps")),
  // Every other pending task on a first win.
  expiresFollowUpIds: v.array(v.id("followUps")),
});

const callPurposeValidator = v.union(v.literal("call_back"), v.literal("payment_owed"));
const contactMethodValidator = v.union(v.literal("call"), v.literal("text"));

export const taskProposalValidator = v.object({
  type: v.literal("task"),
  purpose: callPurposeValidator,
  closerId: v.id("users"),
  meetingId: v.id("meetings"),
  contactMethod: contactMethodValidator,
  reminderScheduledAt: v.number(),
  expectedAmountMinor: v.optional(v.number()), // payment_owed
  expectedCurrency: v.optional(v.string()), // payment_owed
  promisedPaymentAt: v.optional(v.number()), // payment_owed
  // payment_owed: the declineCode of a failed attempt in the call window.
  declineCode: v.optional(v.string()),
});

export const refusalProposalValidator = v.object({
  type: v.literal("refusal"),
  closerId: v.id("users"),
  meetingId: v.id("meetings"),
});

export const alertProposalValidator = v.object({
  type: v.literal("alert"),
  closerId: v.id("users"),
  meetingId: v.id("meetings"),
  graceEndsAt: v.number(),
});

export const decisionProposalValidator = v.union(
  paymentProposalValidator,
  taskProposalValidator,
  refusalProposalValidator,
  alertProposalValidator,
);

// The phase 2 payment evidence. It stays untagged, so its rows still validate.
export const paymentEvidenceValidator = v.object({
  allocationRevision: v.number(),
  sourceUpdatedAt: v.number(),
  bindingIds: v.array(v.id("paymentProviderBindings")),
  bindingVersions: v.array(v.number()),
});

export const callEvidenceRefValidator = v.object({
  type: v.literal("call"),
  runId: v.id("callInsightRuns"),
  recordingId: v.id("callRecordings"),
  generation: v.number(),
  publicationRevision: v.optional(v.number()),
  promptVersion: v.string(),
  model: v.string(),
  thresholdsVersion: v.string(),
  checksVersion: v.string(),
  readTrigger: runTriggerValidator,
  publishedAt: v.number(),
  slotEndedAt: v.number(),
  finalStatementLine: v.optional(v.number()),
});

export const decisionEvidenceValidator = v.union(paymentEvidenceValidator, callEvidenceRefValidator);

// What an applied call write changed, for Undo, reopen and "This call didn't happen".
const callBeforeValidator = v.object({
  position: v.union(v.literal("booked"), v.literal("follow_up")),
  meetingId: v.id("meetings"),
  meetingStatus: v.literal("scheduled"),
  latestActivityAt: v.number(),
  identityReviewRevision: v.optional(v.number()),
  followUpId: v.optional(v.id("followUps")), // The task this write created (task kinds).
});

const meetingStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("held"),
  v.literal("canceled"),
  v.literal("no_show"),
);

const followUpStatusValidator = v.union(
  v.literal("pending"),
  v.literal("booked"),
  v.literal("completed"),
  v.literal("expired"),
);

// What an applied Billing confirmation changed, for one-tap undo.
const dealBeforeValidator = v.object({
  position: v.union(v.literal("booked"), v.literal("follow_up"), v.literal("system_loss"), v.literal("won")),
  systemLossReason: v.optional(v.union(v.literal("no_show"), v.literal("canceled"), v.literal("stale"))),
  lostAt: v.optional(v.number()),
  // The effective value, computed when the row had none.
  latestActivityAt: v.number(),
  meetings: v.array(v.object({ meetingId: v.id("meetings"), status: meetingStatusValidator })), // At most 20.
  tasks: v.array(v.object({ followUpId: v.id("followUps"), status: followUpStatusValidator })), // Changed tasks, at most 20.
});

export const wrongFieldValidator = v.union(
  v.literal("person"),
  v.literal("deal"),
  v.literal("amount"),
  v.literal("currency"),
  v.literal("type"),
  v.literal("program"),
  v.literal("credit"),
  v.literal("should_abstain"),
  v.literal("should_write"),
  v.literal("time"),
  v.literal("method"),
  v.literal("purpose"),
  v.literal("attendance"),
  v.literal("false_loss"),
);

// The grader's own answer, committed before the proposal is shown.
const gradeAnswerValidator = v.object({
  abstain: v.boolean(),
  leadId: v.optional(v.id("leads")),
  opportunityId: v.optional(v.id("opportunities")),
  amountMinor: v.optional(v.number()),
  currency: v.optional(v.string()),
  paymentType: v.optional(paymentTypeValidator),
  programId: v.optional(v.id("tenantPrograms")),
  attributedCloserId: v.optional(v.id("users")),
  // Call kinds.
  taskPurpose: v.optional(callPurposeValidator),
  reminderAt: v.optional(v.number()),
  contactMethod: v.optional(contactMethodValidator),
  expectedAmountMinor: v.optional(v.number()),
  expectedCurrency: v.optional(v.string()),
  refusal: v.optional(v.boolean()),
  attendanceHeld: v.optional(v.boolean()),
  committedByUserId: v.id("users"),
  committedAt: v.number(),
});

const gradeValidator = v.object({
  verdict: v.union(v.literal("correct"), v.literal("wrong"), v.literal("unsure")),
  wrongFields: v.array(wrongFieldValidator),
  gradedByUserId: v.id("users"),
  gradedAt: v.number(),
  gradedBeforeSeeing: v.boolean(), // Set by the server only.
  secondLook: v.optional(v.object({
    verdict: v.union(v.literal("correct"), v.literal("wrong")),
    byUserId: v.id("users"),
    at: v.number(),
  })),
});

export const breakerReasonValidator = v.union(
  v.literal("audit_overdue"),
  v.literal("wrong_write"),
  v.literal("not_my_sale_unanswered"),
  v.literal("certificate_lapsed"),
);

const breakerValidator = v.object({
  trippedAt: v.number(),
  reason: breakerReasonValidator,
  decisionId: v.optional(v.id("resultAutomationDecisions")),
});

const kindPolicyValidator = v.object({
  mode: automationModeValidator,
  policyVersion: v.number(),
  changedAt: v.number(),
  changedByUserId: v.id("users"),
  // The certificate pointer, written only by promoteKind. The sample row holds the rest.
  automatic: v.optional(v.object({
    promotedAt: v.number(),
    promotedByUserId: v.id("users"),
    sampleId: v.id("automationSamples"),
    ruleVersion: v.string(),
    writes: v.number(), // Automatic writes since promotion.
  })),
  breaker: v.optional(breakerValidator),
});

export const resultAutomationSettingsValidator = v.object({
  enabled: v.boolean(),
  activationVersion: v.number(), // Bumped whenever enabled changes.
  pausedAt: v.optional(v.number()),
  changedAt: v.number(),
  changedByUserId: v.id("users"),
  graderUserId: v.optional(v.id("users")),
  kinds: v.object({
    payment_win: kindPolicyValidator,
    additional_payment: kindPolicyValidator,
    call_back: v.optional(kindPolicyValidator),
    payment_owed: v.optional(kindPolicyValidator),
    refusal_loss: v.optional(kindPolicyValidator),
  }),
  refusalNoticeHours: v.optional(v.number()), // 24–168; absent = 48.
  paidOnCallAlert: v.optional(v.object({
    mode: settableAlertModeValidator,
    graceMinutes: v.number(), // Absent settings = 120.
    policyVersion: v.number(),
    changedAt: v.number(),
    changedByUserId: v.id("users"),
  })),
});

export const automationTables = {
  automationPaymentRepairCursors: defineTable({
    tenantId: v.id("tenants"),
    connectionId: v.id("tenantPaymentConnections"),
    connectedAt: v.number(),
    activationVersion: v.number(),
    policyVersions: v.string(),
    lastTick: v.number(),
    paymentCursor: v.optional(v.string()),
    paymentThrough: v.optional(v.number()),
    decisionLane: v.number(),
    decisionCursor: v.optional(v.string()),
    decisionThrough: v.optional(v.number()),
  })
    .index("by_connectionId", ["connectionId"])
    .index("by_tenantId", ["tenantId"]),
  resultAutomationDecisions: defineTable({
    tenantId: v.id("tenants"),
    kind: decisionKindValidator,
    mode: decisionModeValidator,
    state: decisionStateValidator,
    inputKey: v.string(), // SHA-256 of the canonical input tuple.
    vetoKey: v.string(), // SHA-256 of (kind family, providerPaymentId, opportunityId).
    ruleVersion: v.string(),
    policyVersion: v.number(),
    activationVersion: v.number(),
    humanResultRevision: v.number(), // The deal's revision when derived. Zero with no deal.
    wouldWrite: v.boolean(),
    automaticEligible: v.optional(v.boolean()), // A Billing proposal can be outside the automatic payment rule.
    gates: v.array(automationGateValidator),
    providerPaymentId: v.optional(v.id("providerPayments")),
    leadId: v.optional(v.id("leads")),
    opportunityId: v.optional(v.id("opportunities")),
    meetingId: v.optional(v.id("meetings")),
    assignedCloserId: v.optional(v.id("users")),
    noticeUserId: v.optional(v.id("users")), // Who the ask waits on. Absent means Billing.
    confirmRoute: v.optional(confirmRouteValidator),
    proposal: v.optional(decisionProposalValidator),
    evidence: decisionEvidenceValidator,
    runId: v.optional(v.id("callInsightRuns")),
    recordingId: v.optional(v.id("callRecordings")),
    dueAt: v.optional(v.number()), // Grace end, alert due, notice deadline (only once acknowledged).
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
    resolvedByUserId: v.optional(v.id("users")),
    stopCode: v.optional(stopCodeValidator),
    supersededByDecisionId: v.optional(v.id("resultAutomationDecisions")),
    appliedPaymentRecordId: v.optional(v.id("paymentRecords")),
    appliedVia: v.optional(appliedViaValidator),
    before: v.optional(dealBeforeValidator),
    humanResultRevisionAfter: v.optional(v.number()),
    correctionId: v.optional(v.id("paymentCorrections")),
    answer: v.optional(gradeAnswerValidator),
    revealedToUserIds: v.optional(v.array(v.id("users"))), // At most 10.
    grade: v.optional(gradeValidator),
    // Notice acknowledgment or the closer's paid-on-call handoff to Billing.
    acknowledgedAt: v.optional(v.number()),
    // Notice (refusal_loss in state "notice").
    noticeRound: v.optional(v.number()), // A closer change or a late wake-up starts a new round.
    noticeHours: v.optional(v.number()), // Captured at acknowledgment.
    acknowledgedByUserId: v.optional(v.id("users")),
    acknowledgedAs: v.optional(v.union(v.literal("closer"), v.literal("admin"))),
    stopNextStep: v.optional(v.object({
      kind: v.union(v.literal("call_back"), v.literal("reminder_now")),
      followUpId: v.id("followUps"),
    })),
    vetoReleasedAt: v.optional(v.number()),
    vetoReleasedByUserId: v.optional(v.id("users")),
    // Apply receipt (call kinds).
    writtenFollowUpId: v.optional(v.id("followUps")),
    replacementFollowUpId: v.optional(v.id("followUps")),
    callBefore: v.optional(callBeforeValidator),
    // Certificates and audit.
    sampleId: v.optional(v.id("automationSamples")),
    certificateSampleId: v.optional(v.id("automationSamples")), // Automatic writes: the certificate in force.
    auditReason: v.optional(v.union(v.literal("canary"), v.literal("sampled"))),
    auditOpenDueAt: v.optional(v.number()), // Set while the audit is open; cleared when audited.
    auditedAt: v.optional(v.number()),
    auditByUserId: v.optional(v.id("users")),
    auditVerdict: v.optional(v.union(v.literal("correct"), v.literal("wrong"))),
    auditWrongFields: v.optional(v.array(wrongFieldValidator)),
    // Alert.
    alertAnswer: v.optional(v.union(
      v.literal("add_payment"),
      v.literal("paid_by_someone_else"),
      v.literal("not_paid_yet"),
      v.literal("no_payment_found"),
      v.literal("linked"),
    )),
  })
    .index("by_tenantId_and_inputKey", ["tenantId", "inputKey"])
    .index("by_tenantId_and_vetoKey", ["tenantId", "vetoKey"])
    .index("by_tenantId_and_providerPaymentId_and_state", ["tenantId", "providerPaymentId", "state"])
    .index("by_tenantId_and_opportunityId_and_state", ["tenantId", "opportunityId", "state"])
    .index("by_tenantId_and_leadId_and_state", ["tenantId", "leadId", "state"])
    .index("by_tenantId_and_noticeUserId_and_state", ["tenantId", "noticeUserId", "state"])
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
    .index("by_tenantId_and_state_and_createdAt", ["tenantId", "state", "createdAt"])
    .index("by_tenantId_state_stopCode_resolvedAt", ["tenantId", "state", "stopCode", "resolvedAt"])
    .index("by_tenantId_kind_state_resolvedAt", ["tenantId", "kind", "state", "resolvedAt"])
    .index("by_tenantId_kind_state_acknowledgedAt", ["tenantId", "kind", "state", "acknowledgedAt"])
    .index("by_tenantId_and_kind_and_createdAt", ["tenantId", "kind", "createdAt"])
    .index("by_tenantId_and_kind_and_state_and_createdAt", ["tenantId", "kind", "state", "createdAt"])
    .index("by_tenantId_and_kind_and_ruleVersion_and_createdAt", ["tenantId", "kind", "ruleVersion", "createdAt"])
    .index("by_tenantId_and_meetingId", ["tenantId", "meetingId"])
    .index("by_tenantId_and_state_and_dueAt", ["tenantId", "state", "dueAt"])
    .index("by_state_and_dueAt", ["state", "dueAt"]) // Cron: due grace, alert, notice.
    .index("by_tenantId_and_recordingId_and_state", ["tenantId", "recordingId", "state"])
    .index("by_tenantId_and_sampleId_and_leadId", ["tenantId", "sampleId", "leadId"])
    .index("by_tenantId_and_auditOpenDueAt", ["tenantId", "auditOpenDueAt"])
    .index("by_auditOpenDueAt", ["auditOpenDueAt"]) // Cron: audit deadlines.
    .index("by_tenantId_and_mode_and_state_and_resolvedAt", ["tenantId", "mode", "state", "resolvedAt"]),

  // A certificate sample: up to 300 (or 60) graded decisions of one kind and
  // rule version. Its own table, since a sample can't live on the tenant.
  automationSamples: defineTable({
    tenantId: v.id("tenants"),
    kind: automationKindValidator,
    ruleVersion: v.string(), // Payments: PAYMENT_RULE_VERSION; calls: the call rule version.
    target: v.number(), // 300 | 60, frozen when the sample opens.
    status: v.union(
      v.literal("collecting"),
      v.literal("full"),
      v.literal("certified"),
      v.literal("failed"),
      v.literal("lapsed"),
    ),
    lapseReason: v.optional(v.union(v.literal("rule_changed"), v.literal("aged_out"), v.literal("breaker"))),
    firstCaseAt: v.optional(v.number()),
    fullAt: v.optional(v.number()),
    certifiedAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    lapsedAt: v.optional(v.number()),
    failedDecisionId: v.optional(v.id("resultAutomationDecisions")),
    // Payment kinds: the product and variant bindings the graded members used. At most 100.
    scopeBindingIds: v.optional(v.array(v.id("paymentProviderBindings"))),
    createdAt: v.number(),
  })
    .index("by_tenantId_and_kind_and_status", ["tenantId", "kind", "status"])
    .index("by_tenantId_and_kind_and_ruleVersion", ["tenantId", "kind", "ruleVersion"]),

  // Lines in the closer's pinned group on Today about changes to their numbers.
  closerPinnedLines: defineTable({
    tenantId: v.id("tenants"),
    userId: v.id("users"),
    kind: v.union(
      v.literal("win_recorded_from_whop"),
      v.literal("instalment_credited"),
      v.literal("win_removed"),
      v.literal("payment_removed"),
      v.literal("payment_restored"),
      v.literal("call_result_set"), // An automatic call-back or payment-owed task marked the call held.
      v.literal("refusal_recorded"),
      v.literal("refusal_notice_withdrawn"),
      v.literal("refusal_reopened"),
    ),
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
    followUpId: v.optional(v.id("followUps")),
    paymentRecordId: v.optional(v.id("paymentRecords")),
    amountMinor: v.optional(v.number()),
    currency: v.optional(v.string()),
    dealPositionAfter: v.optional(dealPositionValidator),
    decisionId: v.optional(v.id("resultAutomationDecisions")),
    correctionId: v.optional(v.id("paymentCorrections")),
    createdAt: v.number(),
    dismissedAt: v.optional(v.number()),
  }).index("by_tenantId_and_userId_and_dismissedAt_and_createdAt", [
    "tenantId", "userId", "dismissedAt", "createdAt",
  ]),
};
