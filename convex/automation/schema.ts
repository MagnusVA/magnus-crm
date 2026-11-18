import { defineTable } from "convex/server";
import { v } from "convex/values";
import { paymentTypeValidator } from "../lib/paymentTypes";
import { dealPositionValidator } from "../payments/schema";

export const automationKindValidator = v.union(
  v.literal("payment_win"),
  v.literal("additional_payment"),
  // Declared for later phases. Phase 2 never derives or shows these kinds.
  v.literal("call_back"),
  v.literal("payment_owed"),
  v.literal("refusal_loss"),
);

export const automationModeValidator = v.union(
  v.literal("off"),
  v.literal("shadow"),
  v.literal("ask"),
); // Phase 5 adds "automatic".

export const decisionModeValidator = v.union(v.literal("shadow"), v.literal("ask"));

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
); // Phase 5 adds "notice".

export const stopCodeValidator = v.union(
  v.literal("human_result"),
  v.literal("paused"),
  v.literal("kind_lowered"),
  v.literal("person_stop"),
  v.literal("merged"),
  v.literal("adverse"),
  v.literal("input_changed"),
  v.literal("deal_closed"),
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
);

const proposalValidator = v.object({
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

const wrongFieldValidator = v.union(
  v.literal("person"),
  v.literal("deal"),
  v.literal("amount"),
  v.literal("currency"),
  v.literal("type"),
  v.literal("program"),
  v.literal("credit"),
  v.literal("should_abstain"),
  v.literal("should_write"),
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

const kindPolicyValidator = v.object({
  mode: automationModeValidator,
  policyVersion: v.number(),
  changedAt: v.number(),
  changedByUserId: v.id("users"),
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
});

export const automationTables = {
  resultAutomationDecisions: defineTable({
    tenantId: v.id("tenants"),
    kind: automationKindValidator,
    mode: decisionModeValidator,
    state: decisionStateValidator,
    inputKey: v.string(), // SHA-256 of the canonical input tuple.
    vetoKey: v.string(), // SHA-256 of (kind family, providerPaymentId, opportunityId).
    ruleVersion: v.string(),
    policyVersion: v.number(),
    activationVersion: v.number(),
    humanResultRevision: v.number(), // The deal's revision when derived. Zero with no deal.
    wouldWrite: v.boolean(),
    gates: v.array(automationGateValidator),
    providerPaymentId: v.optional(v.id("providerPayments")),
    leadId: v.optional(v.id("leads")),
    opportunityId: v.optional(v.id("opportunities")),
    meetingId: v.optional(v.id("meetings")),
    assignedCloserId: v.optional(v.id("users")),
    noticeUserId: v.optional(v.id("users")), // Who the ask waits on. Absent means Billing.
    confirmRoute: v.optional(confirmRouteValidator),
    proposal: v.optional(proposalValidator),
    evidence: v.object({
      allocationRevision: v.number(),
      sourceUpdatedAt: v.number(),
      bindingIds: v.array(v.id("paymentProviderBindings")),
      bindingVersions: v.array(v.number()),
    }),
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
  })
    .index("by_tenantId_and_inputKey", ["tenantId", "inputKey"])
    .index("by_tenantId_and_vetoKey", ["tenantId", "vetoKey"])
    .index("by_tenantId_and_providerPaymentId_and_state", ["tenantId", "providerPaymentId", "state"])
    .index("by_tenantId_and_opportunityId_and_state", ["tenantId", "opportunityId", "state"])
    .index("by_tenantId_and_leadId_and_state", ["tenantId", "leadId", "state"])
    .index("by_tenantId_and_noticeUserId_and_state", ["tenantId", "noticeUserId", "state"])
    .index("by_tenantId_and_state_and_createdAt", ["tenantId", "state", "createdAt"])
    .index("by_tenantId_and_kind_and_ruleVersion_and_createdAt", ["tenantId", "kind", "ruleVersion", "createdAt"])
    .index("by_tenantId_and_meetingId", ["tenantId", "meetingId"]),

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
    ),
    opportunityId: v.id("opportunities"),
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
