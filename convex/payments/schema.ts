import { defineTable } from "convex/server";
import { v } from "convex/values";
import { enrollmentStatusValidator } from "../enrollments/validators";
import { paymentTypeValidator } from "../lib/paymentTypes";

/**
 * Payments a provider reports (docs/agents/payments.md). Whop is the only
 * provider so far. These tables hold facts: no cash report reads them, and a
 * provider payment counts as money only through a `paymentRecords` row.
 */

export const RAW_RECEIPT_BATCH = 20;
export const MAX_PAYMENT_READ_ATTEMPTS = 20;

export const paymentProviderValidator = v.literal("whop");
export const providerEnvironmentValidator = v.union(
  v.literal("live"),
  v.literal("sandbox"),
);

export const disputeAccessValidator = v.union(v.literal("ok"), v.literal("forbidden"));

export const paymentConnectionStatusValidator = v.union(
  v.literal("connected"),
  v.literal("invalid_key"),
  v.literal("disconnected"),
);

/** Why the last sweep or read failed. A fixed code, never the provider's text. */
export const paymentConnectionErrorValidator = v.union(
  v.literal("unauthorized"),
  v.literal("forbidden"),
  v.literal("rate_limited"),
  v.literal("provider_unavailable"),
  v.literal("unexpected_response"),
  v.literal("account_mismatch"),
);

/** Whop's `status`, plus `unknown` for a value this code has not seen. */
export const providerPaymentStatusValidator = v.union(
  v.literal("draft"),
  v.literal("open"),
  v.literal("authorized"),
  v.literal("paid"),
  v.literal("pending"),
  v.literal("uncollectible"),
  v.literal("unresolved"),
  v.literal("void"),
  v.literal("unknown"),
);

/**
 * Where a provider payment stands with the CRM.
 *
 * - `not_actionable`: not paid, or paid for nothing (zero), so nobody acts.
 * - `needs_person`: paid, and no CRM payment counts for it yet.
 * - `linked`: a person tied it to a CRM payment someone recorded by hand.
 * - `recorded`: the CRM payment that counts was created from it.
 * - `dismissed`: a person said it is not money for a deal in this CRM.
 * - `historical`: paid before the connection's `autoImportAfter`.
 */
export const providerPaymentReviewStateValidator = v.union(
  v.literal("not_actionable"),
  v.literal("needs_person"),
  v.literal("linked"),
  v.literal("recorded"),
  v.literal("dismissed"),
  v.literal("historical"),
);

/** The matcher outcome. One fixed code; the screen has the words. */
export const providerPaymentReviewReasonValidator = v.union(
  // The rule found one person with exactly one open deal: ready to confirm.
  v.literal("ready"),
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
  // The only candidate deal is one a person took this payment off.
  v.literal("excluded_wrong_match"),
);

/** How the CRM payment was tied to the provider payment. */
export const providerPaymentMatchMethodValidator = v.union(
  v.literal("checkout_binding"),
  v.literal("membership_binding"),
  v.literal("email_one_open_deal"),
  v.literal("person"),
);

/** The worst refund or dispute state the provider has reported. */
export const providerAdverseStateValidator = v.union(
  v.literal("none"),
  v.literal("refund_pending"),
  v.literal("partially_refunded"),
  v.literal("refunded"),
  v.literal("dispute_open"),
  v.literal("dispute_won"),
  v.literal("dispute_lost"),
);

/** Why a person said a provider payment is not money for a deal here. */
export const providerPaymentDismissReasonValidator = v.union(
  v.literal("not_crm_money"),
  v.literal("test_payment"),
  v.literal("duplicate_in_provider"),
  v.literal("other"),
);

export const webhookReceiptStatusValidator = v.union(
  v.literal("received"),
  v.literal("processed"),
  v.literal("ignored"),
  v.literal("failed"),
);

export const webhookFailureCodeValidator = v.union(
  v.literal("unreadable_body"),
  v.literal("unknown_event"),
  v.literal("missing_object"),
  v.literal("provider_read_failed"),
  v.literal("account_mismatch"),
  v.literal("attempts_exhausted"),
  v.literal("released_by_person"),
  v.literal("connection_unavailable"),
);

/** One confirmed relationship between something in Whop and something here. */
export const paymentProviderBindingValidator = v.union(
  // A Whop product is one of the tenant's programs.
  v.object({
    kind: v.literal("product_program"),
    programId: v.id("tenantPrograms"),
  }),
  // A Whop variant (price) is a payment type, optionally a different one for
  // charges after the first (a deposit, then monthly).
  v.object({
    kind: v.literal("variant_type"),
    paymentType: paymentTypeValidator,
    laterPaymentType: v.optional(paymentTypeValidator),
  }),
  // A Whop membership belongs to one deal. The anchor is the CRM payment a
  // person confirmed; undoing or re-matching it disables the binding.
  v.object({
    kind: v.literal("membership_deal"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    anchorPaymentRecordId: v.id("paymentRecords"),
  }),
  // A checkout link the CRM made for one deal (a later phase).
  v.object({
    kind: v.literal("checkout_deal"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
  }),
);

export const exclusionCauseValidator = v.union(
  v.literal("wrong_match"),
  v.literal("refund"),
  v.literal("chargeback"),
  v.literal("voided"),
);

export const correctionResultValidator = v.union(
  // Another payment counts. The first-payment time moved.
  v.literal("kept_won"),
  v.literal("undo_booked"),
  v.literal("undo_follow_up"),
  v.literal("undo_system_loss"),
  // Undo found that Calendly had canceled the meeting or marked it a no-show.
  v.literal("system_loss_on_undo"),
  v.literal("lost"),
  v.literal("follow_up"),
  v.literal("restored_kept_won"),
  v.literal("restored_won"),
);

// Matches DEAL_POSITIONS.
export const dealPositionValidator = v.union(
  v.literal("qualified"),
  v.literal("booked"),
  v.literal("call_held"),
  v.literal("follow_up"),
  v.literal("won"),
  v.literal("lost"),
);

export const paymentProviderTables = {
  // One provider account for a tenant. Only internal functions read `apiKey`
  // and the webhook secrets; the browser gets a masked view.
  tenantPaymentConnections: defineTable({
    tenantId: v.id("tenants"),
    provider: paymentProviderValidator,
    environment: providerEnvironmentValidator,
    // Whop's account id (`biz_…`). Every signed delivery must name it.
    accountId: v.string(),
    accountTitle: v.optional(v.string()),
    credentialKind: v.union(v.literal("account_key"), v.literal("app")),
    apiKey: v.string(),
    keyLast4: v.string(),
    webhookSecret: v.optional(v.string()),
    // Accepted until `previousWebhookSecretUntil`, while a secret is rotated.
    previousWebhookSecret: v.optional(v.string()),
    previousWebhookSecretUntil: v.optional(v.number()),
    // The dated API version every request pins (`Api-Version-Date`).
    apiVersionDate: v.string(),
    disputeAccess: disputeAccessValidator,
    lastInvalidSignatureWarningAt: v.optional(v.number()),
    status: paymentConnectionStatusValidator,
    // Payments collected before this are history: shown, never proposed.
    autoImportAfter: v.number(),
    connectedByUserId: v.id("users"),
    connectedAt: v.number(),
    disconnectedAt: v.optional(v.number()),
    lastWebhookAt: v.optional(v.number()),
    lastSuccessfulSweepAt: v.optional(v.number()),
    lastFullScanAt: v.optional(v.number()),
    // The newest `created_at` the recent sweep has covered.
    sweepCreatedThrough: v.optional(v.number()),
    recentSweepProgress: v.optional(v.object({
      through: v.number(), stage: v.number(), cursor: v.union(v.string(), v.null()),
    })),
    // A full scan in progress: Whop's cursor for the next page.
    fullScanCursor: v.optional(v.string()),
    fullScanStartedAt: v.optional(v.number()),
    // One sweep at a time per connection.
    sweepToken: v.optional(v.string()),
    sweepUntil: v.optional(v.number()),
    // A shared request clock, so sweeps and refreshes stay under the limit.
    nextRequestAt: v.optional(v.number()),
    lastErrorCode: v.optional(paymentConnectionErrorValidator),
    lastErrorAt: v.optional(v.number()),
  })
    .index("by_tenantId_and_provider_and_environment", [
      "tenantId",
      "provider",
      "environment",
    ])
    // The status suffix lets ownership checks skip disconnected history.
    .index("by_provider_and_environment_and_accountId_and_status", [
      "provider",
      "environment",
      "accountId",
      "status",
    ])
    .index("by_status", ["status"]),

  // One provider payment, as last read from the provider. Never cash.
  providerPayments: defineTable({
    tenantId: v.id("tenants"),
    connectionId: v.id("tenantPaymentConnections"),
    externalPaymentId: v.string(),
    status: providerPaymentStatusValidator,
    // Whop's substatus as sent. An enum there, kept as a short string here so
    // a new value is stored, not dropped.
    substatus: v.optional(v.string()),
    billingReason: v.optional(v.string()),
    // The provider's `updated_at`. An older read never overwrites a newer one.
    sourceUpdatedAt: v.number(),
    sourceCreatedAt: v.number(),
    // Bumped by every request to read this payment again; a read applies only
    // if its generation is still the newest.
    refreshGeneration: v.number(),
    refreshedAt: v.optional(v.number()),
    storedRefreshGeneration: v.optional(v.number()),
    retryReadAt: v.optional(v.number()),
    retryReadAttempts: v.optional(v.number()),
    firstSeenAt: v.number(),
    paidAt: v.optional(v.number()),
    // `total`: after discounts, with tax, without the buyer's fees. Exact
    // minor units; absent when the currency is not a two-decimal one.
    totalMinor: v.optional(v.number()),
    currency: v.string(),
    decimals: v.number(),
    // What the buyer was charged, in the buyer's currency. Shown, never summed.
    buyerChargedMinor: v.optional(v.number()),
    buyerChargedCurrency: v.optional(v.string()),
    refundedMinor: v.number(),
    adverseState: providerAdverseStateValidator,
    // Set the moment a refund or dispute delivery arrives, before the read
    // that explains it. Nothing financial is written while it is set.
    adverseFencedAt: v.optional(v.number()),
    adverseFenceRevision: v.number(),
    sourceAdverseState: v.optional(providerAdverseStateValidator),
    adverseReviewAt: v.optional(v.number()),
    adverseReviewRevision: v.number(),
    refundedAt: v.optional(v.number()),
    disputeCreatedAt: v.optional(v.number()),
    membershipId: v.optional(v.string()),
    memberId: v.optional(v.string()),
    providerUserId: v.optional(v.string()),
    productId: v.optional(v.string()),
    variantId: v.optional(v.string()),
    checkoutConfigurationId: v.optional(v.string()),
    productTitle: v.optional(v.string()),
    variantTitle: v.optional(v.string()),
    lineItemCount: v.number(),
    paymentMethodType: v.optional(v.string()),
    financingInstallmentsCount: v.optional(v.number()),
    failedAttemptCount: v.number(),
    // From a fixed list; anything else is stored as `other`.
    declineCode: v.optional(v.string()),
    // Normalized. Contact details have an absolute retention deadline.
    payerEmail: v.optional(v.string()),
    // Only when it arrived with a country code. Cleared with the email.
    payerPhone: v.optional(v.string()),
    payerDetailsClearedAt: v.optional(v.number()),
    payerDetailsExpireAt: v.optional(v.number()),
    hasPayerDetails: v.optional(v.boolean()),

    // What the matcher last found. A hint for the screen; every write
    // repeats the checks.
    candidateLeadId: v.optional(v.id("leads")),
    candidateOpportunityId: v.optional(v.id("opportunities")),
    matchedAt: v.optional(v.number()),

    // The resolution. `paymentRecordId` is the one CRM payment that counts for
    // this provider payment now (the active allocation). `paymentRecords`
    // rows keep `providerPaymentId` as provenance after they stop counting.
    leadId: v.optional(v.id("leads")),
    opportunityId: v.optional(v.id("opportunities")),
    paymentRecordId: v.optional(v.id("paymentRecords")),
    allocationRevision: v.number(),
    matchMethod: v.optional(providerPaymentMatchMethodValidator),
    reviewState: providerPaymentReviewStateValidator,
    reviewReason: v.optional(providerPaymentReviewReasonValidator),
    // Set while `reviewState` is `dismissed`.
    dismissReason: v.optional(providerPaymentDismissReasonValidator),
    resolvedAt: v.optional(v.number()),
    resolvedByUserId: v.optional(v.id("users")),
    // Wrong-match deals the matcher skips. A person choosing one in Billing
    // removes it from this list. At most 20.
    excludedOpportunityIds: v.optional(v.array(v.id("opportunities"))),
    // A closer's "This isn't my sale" flag, until Billing resolves it.
    notMySaleAt: v.optional(v.number()),
    notMySaleByUserId: v.optional(v.id("users")),
  })
    .index("by_tenantId_and_connectionId_and_externalPaymentId", [
      "tenantId",
      "connectionId",
      "externalPaymentId",
    ])
    // Phase 2 checks the reciprocal active allocation through this index.
    .index("by_tenantId_and_paymentRecordId", ["tenantId", "paymentRecordId"])
    .index("by_tenantId_and_reviewState_and_firstSeenAt", [
      "tenantId",
      "reviewState",
      "firstSeenAt",
    ])
    .index("by_connectionId_and_tenantId_and_reviewState_and_firstSeenAt", ["connectionId", "tenantId", "reviewState", "firstSeenAt"])
    .index("by_tenantId_and_adverseReviewAt", ["tenantId", "adverseReviewAt"])
    .index("by_tenantId_and_notMySaleAt", ["tenantId", "notMySaleAt"])
    .index("by_connectionId_and_tenantId_and_adverseReviewAt", ["connectionId", "tenantId", "adverseReviewAt"])
    .index("by_tenantId_and_opportunityId", ["tenantId", "opportunityId"])
    .index("by_tenantId_and_candidateOpportunityId", ["tenantId", "candidateOpportunityId"])
    .index("by_tenantId_and_leadId_and_paidAt", ["tenantId", "leadId", "paidAt"])
    .index("by_tenantId_and_candidateLeadId_and_paidAt", [
      "tenantId",
      "candidateLeadId",
      "paidAt",
    ])
    .index("by_tenantId_and_payerEmail_and_paidAt", [
      "tenantId",
      "payerEmail",
      "paidAt",
    ])
    .index("by_connectionId_and_leadId_and_paidAt", ["connectionId", "leadId", "paidAt"])
    .index("by_connectionId_and_candidateLeadId_and_paidAt", ["connectionId", "candidateLeadId", "paidAt"])
    .index("by_connectionId_and_payerEmail_and_paidAt", ["connectionId", "payerEmail", "paidAt"])
    .index("by_connectionId_and_status_and_sourceCreatedAt_and_firstSeenAt", [
      "connectionId", "status", "sourceCreatedAt", "firstSeenAt",
    ])
    .index("by_connectionId_and_retryReadAt", ["connectionId", "retryReadAt"])
    .index("by_connectionId_and_retryReadAttempts", ["connectionId", "retryReadAttempts"])
    .index("by_connectionId_and_adverseFencedAt", ["connectionId", "adverseFencedAt"])
    .index("by_connectionId_and_adverseState_and_adverseFencedAt", ["connectionId", "adverseState", "adverseFencedAt"])
    .index("by_hasPayerDetails_and_payerDetailsExpireAt", ["hasPayerDetails", "payerDetailsExpireAt"]),

  paymentProviderBindings: defineTable({
    tenantId: v.id("tenants"),
    connectionId: v.id("tenantPaymentConnections"),
    // The Whop id this binding is about: product, variant, membership or
    // checkout configuration, by `binding.kind`.
    externalId: v.string(),
    // Copied from `binding.kind`, so one index serves every kind.
    kind: v.union(
      v.literal("product_program"),
      v.literal("variant_type"),
      v.literal("membership_deal"),
      v.literal("checkout_deal"),
    ),
    binding: paymentProviderBindingValidator,
    // Present on the deal kinds, for the index by deal.
    opportunityId: v.optional(v.id("opportunities")),
    externalTitle: v.optional(v.string()),
    version: v.number(),
    enabled: v.boolean(),
    // Why a deal binding stopped applying: its anchor payment was undone.
    disabledReason: v.optional(
      v.union(v.literal("anchor_undone"), v.literal("removed")),
    ),
    setByUserId: v.id("users"),
    setAt: v.number(),
    // An audit found a wrong amount, type or program on an automatic write:
    // this mapping stays at ask until a new sample covers it.
    automaticHeldAt: v.optional(v.number()),
    automaticHeldDecisionId: v.optional(v.id("resultAutomationDecisions")),
  })
    .index("by_tenantId_and_connectionId_and_kind_and_externalId", [
      "tenantId",
      "connectionId",
      "kind",
      "externalId",
    ])
    .index("by_tenantId_kind_enabled_anchorPaymentRecordId", [
      "tenantId", "kind", "enabled", "binding.anchorPaymentRecordId",
    ])
    .index("by_tenantId_and_opportunityId_and_kind", [
      "tenantId",
      "opportunityId",
      "kind",
    ]),

  // One delivery from the provider. Kept for good, so a redelivery is known;
  // the raw body is deleted after 7 days.
  paymentWebhookReceipts: defineTable({
    tenantId: v.id("tenants"),
    connectionId: v.id("tenantPaymentConnections"),
    webhookId: v.string(),
    eventType: v.string(),
    externalPaymentId: v.optional(v.string()),
    externalObjectId: v.optional(v.string()),
    bodySha256: v.string(),
    rawBody: v.optional(v.string()),
    hasRawBody: v.optional(v.boolean()),
    adversePending: v.optional(v.boolean()),
    rawBodyDeletedAt: v.optional(v.number()),
    status: webhookReceiptStatusValidator,
    attempts: v.number(),
    failureCode: v.optional(webhookFailureCodeValidator),
    receivedAt: v.number(),
    processedAt: v.optional(v.number()),
    retryAt: v.optional(v.number()),
  })
    .index("by_tenantId_and_connectionId_and_webhookId", [
      "tenantId",
      "connectionId",
      "webhookId",
    ])
    .index("by_hasRawBody_and_receivedAt", ["hasRawBody", "receivedAt"])
    .index("by_connectionId_and_externalPaymentId_and_externalObjectId", [
      "connectionId", "externalPaymentId", "externalObjectId",
    ])
    .index("by_connectionId_and_externalPaymentId_and_adversePending", [
      "connectionId", "externalPaymentId", "adversePending",
    ]),

  // One exclusion or restore receipt for retries and restoration.
  paymentCorrections: defineTable({
    tenantId: v.id("tenants"),
    operation: v.union(v.literal("exclude"), v.literal("restore")),
    // SHA-256 of (operation, subject id, expectedFingerprint, disposition).
    requestKey: v.string(),
    level: v.optional(v.union(v.literal("undo"), v.literal("reviewed"))), // Exclude only.
    cause: v.optional(exclusionCauseValidator), // Exclude only.
    result: correctionResultValidator,
    paymentRecordId: v.id("paymentRecords"),
    providerPaymentId: v.optional(v.id("providerPayments")),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    decisionId: v.optional(v.id("resultAutomationDecisions")),
    restoresCorrectionId: v.optional(v.id("paymentCorrections")),
    restoredByCorrectionId: v.optional(v.id("paymentCorrections")),
    before: v.object({
      paymentStatus: v.union(v.literal("recorded"), v.literal("verified"), v.literal("disputed")),
      providerReviewState: v.optional(providerPaymentReviewStateValidator),
      allocationRevision: v.optional(v.number()),
      dealPosition: dealPositionValidator,
      paymentReceivedAt: v.optional(v.number()),
      lostAt: v.optional(v.number()),
    }),
    after: v.object({
      dealPosition: dealPositionValidator,
      paymentReceivedAt: v.optional(v.number()),
      lostAt: v.optional(v.number()),
      allocationRevision: v.optional(v.number()),
      humanResultRevision: v.number(),
    }),
    tasks: v.array(v.object({ // At most 20.
      followUpId: v.id("followUps"),
      change: v.union(
        v.literal("reopened"),
        v.literal("created"),
        v.literal("expired"),
        v.literal("completed"),
        v.literal("repointed"),
      ),
    })),
    removedEnrollments: v.array(v.object({ // At most 20.
      programId: v.id("tenantPrograms"),
      status: enrollmentStatusValidator,
    })),
    vetoedOpportunityId: v.optional(v.id("opportunities")),
    actorUserId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_tenantId_and_requestKey", ["tenantId", "requestKey"])
    .index("by_tenantId_and_paymentRecordId_and_createdAt", ["tenantId", "paymentRecordId", "createdAt"])
    .index("by_tenantId_and_opportunityId_and_createdAt", ["tenantId", "opportunityId", "createdAt"]),
};
