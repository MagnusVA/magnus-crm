import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireBillingOpsEnabled, requireBillingPermission } from "../billing/guards";
import { followMergeChain } from "../leads/identityResolution";
import { emitDomainEvent } from "../lib/domainEvents";
import { leadDisplayString } from "../lib/leadDisplay";
import { expectedError } from "../lib/observability/errors";
import { paymentTypeValidator } from "../lib/paymentTypes";
import { dealOutcomeValidator, dealStageValidator } from "../opportunities/stages";
import { findPaymentTarget, refreshProviderPaymentReview } from "./match";
import {
  paymentProviderTables,
  providerPaymentMatchMethodValidator,
  providerPaymentReviewReasonValidator,
  providerPaymentDismissReasonValidator,
} from "./schema";

const PAGE_LIMIT = 50;
const COUNT_LIMIT = 500;
const PERSON_DEAL_LIMIT = 100;
const MANUAL_PAYMENT_LIMIT = 50;
const MANUAL_PAYMENT_SCAN_LIMIT = 200;
const ALLOCATION_HISTORY_LIMIT = 40;
const MEMBERSHIP_BINDING_LIMIT = 100;
const SWEEP_FRESHNESS_MS = 15 * 60 * 1000;

const providerPaymentIdValidator = v.id("providerPayments");
const paymentRecordIdValidator = v.id("paymentRecords");
const providerPaymentArgs = { providerPaymentId: providerPaymentIdValidator };
const nullableNumber = v.union(v.number(), v.null());
const nullableString = v.union(v.string(), v.null());

const providerPaymentValidator = v.object({
  ...paymentProviderTables.providerPayments.validator.fields,
  _id: providerPaymentIdValidator,
  _creationTime: v.number(),
});

const dismissReasonValidator = providerPaymentDismissReasonValidator;

const personSummaryValidator = v.object({
  leadId: v.id("leads"),
  displayName: v.string(),
});

const dealSummaryValidator = v.object({
  opportunityId: v.id("opportunities"),
  stage: dealStageValidator,
  outcome: dealOutcomeValidator,
  createdAt: v.number(),
  latestMeetingAt: nullableNumber,
  programName: nullableString,
});

const manualPaymentValidator = v.object({
  paymentRecordId: paymentRecordIdValidator,
  opportunityId: v.id("opportunities"),
  amountMinor: v.number(),
  currency: v.string(),
  paymentType: paymentTypeValidator,
  programId: v.id("tenantPrograms"),
  programName: v.string(),
  recordedAt: v.number(),
  recordedByUserId: v.id("users"),
  recordedByName: nullableString,
});

const targetValidator = v.union(
  v.object({
    kind: v.literal("resolved"),
    paymentRecordId: paymentRecordIdValidator,
    leadId: v.optional(v.id("leads")),
    opportunityId: v.optional(v.id("opportunities")),
    matchMethod: v.optional(providerPaymentMatchMethodValidator),
  }),
  v.object({
    kind: v.literal("ready"),
    leadId: v.id("leads"),
    opportunityId: v.id("opportunities"),
    matchMethod: providerPaymentMatchMethodValidator,
  }),
  v.object({
    kind: v.literal("needs_person"),
    reason: providerPaymentReviewReasonValidator,
    candidateLeadId: v.optional(v.id("leads")),
    candidateOpportunityIds: v.array(v.id("opportunities")),
  }),
);

function exceptionQueue(ctx: QueryCtx, tenantId: Id<"tenants">) {
  return ctx.db.query("providerPayments")
    .withIndex("by_tenantId_and_reviewState_and_firstSeenAt", (q) =>
      q.eq("tenantId", tenantId).eq("reviewState", "needs_person"))
    .order("asc");
}

function personSummary(lead: Doc<"leads"> | null | undefined) {
  return lead ? { leadId: lead._id, displayName: leadDisplayString(lead) } : null;
}

async function loadPerson(ctx: QueryCtx, tenantId: Id<"tenants">, leadId?: Id<"leads">) {
  const lead = leadId && await ctx.db.get("leads", leadId);
  return lead && lead.tenantId === tenantId ? await followMergeChain(ctx, lead) : undefined;
}

function dealSummary(deal: Doc<"opportunities">) {
  return {
    opportunityId: deal._id,
    stage: deal.stage,
    outcome: deal.outcome,
    createdAt: deal.createdAt,
    latestMeetingAt: deal.latestMeetingAt ?? null,
    programName: deal.soldProgramName ?? deal.firstBookingProgramName ?? null,
  };
}

async function connectionFreshness(ctx: QueryCtx, payment: Doc<"providerPayments">, now: number) {
  const connection = await ctx.db.get("tenantPaymentConnections", payment.connectionId);
  const lastSuccessfulSweepAt = connection?.tenantId === payment.tenantId
    ? connection.lastSuccessfulSweepAt
    : undefined;
  return {
    sweepFresh: connection?.status === "connected" && lastSuccessfulSweepAt !== undefined &&
      now - lastSuccessfulSweepAt <= SWEEP_FRESHNESS_MS,
    lastSuccessfulSweepAt: lastSuccessfulSweepAt ?? null,
  };
}

export const listProviderExceptions = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(v.object({
      providerPaymentId: providerPaymentIdValidator,
      totalMinor: nullableNumber,
      currency: v.string(),
      paidAt: nullableNumber,
      firstSeenAt: v.number(),
      productTitle: nullableString,
      variantTitle: nullableString,
      reviewReason: v.union(providerPaymentReviewReasonValidator, v.null()),
      payerEmail: nullableString,
      candidatePerson: v.union(personSummaryValidator, v.null()),
      candidateDeal: v.union(dealSummaryValidator, v.null()),
      sweepFresh: v.boolean(),
      lastSuccessfulSweepAt: nullableNumber,
    })),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(nullableString),
    pageStatus: v.optional(v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())),
  }),
  handler: async (ctx, { paginationOpts }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const now = Date.now();
    const page = await exceptionQueue(ctx, tenantId).paginate({
      ...paginationOpts,
      numItems: Math.min(PAGE_LIMIT, Math.max(1, Math.floor(paginationOpts.numItems) || 1)),
      maximumRowsRead: Math.min(PAGE_LIMIT, paginationOpts.maximumRowsRead ?? PAGE_LIMIT),
      maximumBytesRead: Math.min(2_000_000, paginationOpts.maximumBytesRead ?? 2_000_000),
    });
    return {
      ...page,
      page: await Promise.all(page.page.map(async (payment) => {
        const [lead, deal, freshness] = await Promise.all([
          loadPerson(ctx, tenantId, payment.candidateLeadId),
          payment.candidateOpportunityId && ctx.db.get("opportunities", payment.candidateOpportunityId),
          connectionFreshness(ctx, payment, now),
        ]);
        return {
          providerPaymentId: payment._id,
          totalMinor: payment.totalMinor ?? null,
          currency: payment.currency,
          paidAt: payment.paidAt ?? null,
          firstSeenAt: payment.firstSeenAt,
          productTitle: payment.productTitle ?? null,
          variantTitle: payment.variantTitle ?? null,
          reviewReason: payment.reviewReason ?? null,
          payerEmail: payment.payerEmail ?? null,
          candidatePerson: personSummary(lead),
          candidateDeal: lead && deal?.tenantId === tenantId && deal.leadId === lead._id ? dealSummary(deal) : null,
          ...freshness,
        };
      })),
    };
  },
});

export const getProviderExceptionCounts = query({
  args: {},
  returns: v.object({ count: v.number(), capped: v.boolean() }),
  handler: async (ctx) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const rows = await exceptionQueue(ctx, tenantId).take(COUNT_LIMIT + 1);
    return { count: Math.min(rows.length, COUNT_LIMIT), capped: rows.length > COUNT_LIMIT };
  },
});

async function listManualPayments(ctx: QueryCtx, tenantId: Id<"tenants">, leadId?: Id<"leads">) {
  if (!leadId) return { manualPayments: [], manualPaymentsCapped: false };
  const deals = await ctx.db.query("opportunities").withIndex("by_tenantId_and_leadId", (q) =>
    q.eq("tenantId", tenantId).eq("leadId", leadId)).take(PERSON_DEAL_LIMIT + 1);
  let capped = deals.length > PERSON_DEAL_LIMIT;
  let scanned = 0;
  const candidates: Array<Doc<"paymentRecords"> & { opportunityId: Id<"opportunities"> }> = [];
  for (const deal of deals.slice(0, PERSON_DEAL_LIMIT)) {
    const limit = Math.min(MANUAL_PAYMENT_LIMIT, MANUAL_PAYMENT_SCAN_LIMIT - scanned);
    if (limit === 0) {
      capped = true;
      break;
    }
    const records = await ctx.db.query("paymentRecords").withIndex("by_opportunityId_and_recordedAt", (q) =>
      q.eq("opportunityId", deal._id)).order("desc").take(limit + 1);
    if (records.length > limit) capped = true;
    scanned += Math.min(records.length, limit);
    for (const record of records.slice(0, limit)) {
      if (record.tenantId !== tenantId || record.status === "disputed" || record.providerPaymentId) continue;
      candidates.push({ ...record, opportunityId: deal._id });
    }
  }
  candidates.sort((a, b) => b.recordedAt - a.recordedAt || a._id.localeCompare(b._id));
  const manualPayments = await Promise.all(candidates.slice(0, MANUAL_PAYMENT_LIMIT).map(async (record) => {
    const user = await ctx.db.get("users", record.recordedByUserId);
    return {
      paymentRecordId: record._id,
      opportunityId: record.opportunityId,
      amountMinor: record.amountMinor,
      currency: record.currency,
      paymentType: record.paymentType,
      programId: record.programId,
      programName: record.programName,
      recordedAt: record.recordedAt,
      recordedByUserId: record.recordedByUserId,
      recordedByName: user?.tenantId === tenantId ? user.fullName?.trim() || user.email : null,
    };
  }));
  return { manualPayments, manualPaymentsCapped: capped || candidates.length > MANUAL_PAYMENT_LIMIT };
}

export const getProviderPayment = query({
  args: { ...providerPaymentArgs, leadId: v.optional(v.id("leads")) },
  returns: v.union(v.null(), v.object({
    payment: providerPaymentValidator,
    classification: targetValidator,
    candidatePerson: v.union(personSummaryValidator, v.null()),
    candidateDeals: v.array(dealSummaryValidator),
    manualPayments: v.array(manualPaymentValidator),
    manualPaymentsCapped: v.boolean(),
    sweepFresh: v.boolean(),
    lastSuccessfulSweepAt: nullableNumber,
  })),
  handler: async (ctx, { providerPaymentId, leadId }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const payment = await ctx.db.get("providerPayments", providerPaymentId);
    if (payment?.tenantId !== tenantId) return null;

    const classification = await findPaymentTarget(ctx, payment);
    const candidateLeadId = classification.kind === "needs_person" ? classification.candidateLeadId : classification.leadId;
    const dealIds = classification.kind === "needs_person"
      ? classification.candidateOpportunityIds
      : classification.opportunityId ? [classification.opportunityId] : [];
    const [lead, deals, freshness, selectedPerson] = await Promise.all([
      loadPerson(ctx, tenantId, candidateLeadId),
      Promise.all(dealIds.map((id) => ctx.db.get("opportunities", id))),
      connectionFreshness(ctx, payment, Date.now()),
      leadId ? loadPerson(ctx, tenantId, leadId) : undefined,
    ]);
    const candidateDeals = deals.flatMap((deal) =>
      lead && deal?.tenantId === tenantId && deal?.leadId === lead._id ? [dealSummary(deal)] : []);
    return {
      payment,
      classification,
      candidatePerson: personSummary(lead),
      candidateDeals,
      ...await listManualPayments(ctx, tenantId, leadId ? selectedPerson?._id : lead?._id),
      ...freshness,
    };
  },
});

/** The evidence attached to a CRM payment, including retained provenance. */
export const getLinkedProviderPayment = query({
  args: { paymentRecordId: paymentRecordIdValidator },
  returns: v.union(providerPaymentValidator, v.null()),
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const record = await ctx.db.get("paymentRecords", paymentRecordId);
    if (record?.tenantId !== tenantId || !record.providerPaymentId) return null;
    const payment = await ctx.db.get("providerPayments", record.providerPaymentId);
    return payment?.tenantId === tenantId ? payment : null;
  },
});

async function requiredProviderPayment(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  providerPaymentId: Id<"providerPayments">,
) {
  const payment = await ctx.db.get("providerPayments", providerPaymentId);
  if (payment?.tenantId !== tenantId) throw expectedError("provider_payment.not_found", "Provider payment not found.");
  return payment;
}

async function emitLinkEvent(
  ctx: MutationCtx,
  eventType: "payment.provider_linked" | "payment.provider_unlinked",
  actor: { tenantId: Id<"tenants">; userId: Id<"users"> },
  paymentRecordId: Id<"paymentRecords">,
  providerPaymentId: Id<"providerPayments">,
) {
  await emitDomainEvent(ctx, {
    tenantId: actor.tenantId,
    entityType: "payment",
    entityId: paymentRecordId,
    eventType,
    source: "admin",
    actorUserId: actor.userId,
    metadata: { providerPaymentId, paymentRecordId },
  });
}

export const linkToPaymentRecord = mutation({
  args: {
    ...providerPaymentArgs,
    paymentRecordId: paymentRecordIdValidator,
    acknowledgeAmountDifference: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { providerPaymentId, paymentRecordId, acknowledgeAmountDifference }) => {
    const actor = await requireBillingPermission(ctx, "billing:review");
    await requireBillingOpsEnabled(ctx, actor.tenantId);
    const payment = await requiredProviderPayment(ctx, actor.tenantId, providerPaymentId);
    const record = await ctx.db.get("paymentRecords", paymentRecordId);
    if (record?.tenantId !== actor.tenantId) throw expectedError("provider_payment.record_not_found", "CRM payment not found.");

    if (payment.paymentRecordId === paymentRecordId && record.providerPaymentId === providerPaymentId) return null;
    if (payment.paymentRecordId || payment.reviewState === "linked" || payment.reviewState === "recorded") {
      throw expectedError("provider_payment.already_allocated", "This provider payment has an active allocation.");
    }
    if (payment.reviewState === "dismissed") throw expectedError("provider_payment.dismissed", "Reopen this provider payment first.");
    if (payment.status !== "paid") throw expectedError("provider_payment.not_paid", "The provider has not marked this payment paid.");
    if (record.status === "disputed") throw expectedError("provider_payment.record_disputed", "This CRM payment is disputed.");
    if (record.providerPaymentId) throw expectedError("provider_payment.record_already_linked", "This CRM payment already has provider evidence.");
    if (payment.currency !== record.currency) throw expectedError("provider_payment.currency_mismatch", "The payment currencies differ.");
    if (payment.totalMinor === undefined) throw expectedError("provider_payment.unsupported_currency", "The provider amount is unavailable.");
    if (payment.totalMinor !== record.amountMinor && !acknowledgeAmountDifference) {
      throw expectedError("provider_payment.amount_mismatch", "Confirm the difference between the two amounts.");
    }

    // The active pointer is authoritative. Fail closed if an older or
    // inconsistent backlink would leave two counting records with this evidence.
    const provenance = await ctx.db.query("paymentRecords")
      .withIndex("by_tenantId_and_providerPaymentId", (q) =>
        q.eq("tenantId", actor.tenantId).eq("providerPaymentId", providerPaymentId))
      .take(ALLOCATION_HISTORY_LIMIT + 1);
    if (provenance.some((row) => row.status !== "disputed")) {
      throw expectedError("provider_payment.already_allocated", "A counting CRM payment already has this evidence.");
    }
    if (provenance.length > ALLOCATION_HISTORY_LIMIT) {
      throw expectedError("provider_payment.allocation_check_incomplete", "Too many previous links to verify.");
    }

    const deal = record.opportunityId && await ctx.db.get("opportunities", record.opportunityId);
    const lead = deal && await ctx.db.get("leads", deal.leadId);
    if (!deal || deal.tenantId !== actor.tenantId || !lead || lead.tenantId !== actor.tenantId || lead.status === "merged") {
      throw expectedError("provider_payment.invalid_record_target", "The CRM payment needs a deal with a current person.");
    }
    await ctx.db.patch("paymentRecords", paymentRecordId, {
      providerPaymentId,
      providerPaidAt: payment.paidAt,
    });
    await ctx.db.patch("providerPayments", providerPaymentId, {
      paymentRecordId,
      opportunityId: deal._id,
      leadId: lead._id,
      matchMethod: "person",
      reviewState: "linked",
      reviewReason: undefined,
      resolvedAt: Date.now(),
      resolvedByUserId: actor.userId,
    });
    await emitLinkEvent(ctx, "payment.provider_linked", actor, paymentRecordId, providerPaymentId);
    return null;
  },
});

async function disableMembershipBindings(
  ctx: MutationCtx,
  payment: Doc<"providerPayments">,
  record: Doc<"paymentRecords">,
) {
  const opportunityId = record.opportunityId;
  if (!opportunityId) return;
  const rows = await ctx.db.query("paymentProviderBindings")
    .withIndex("by_tenantId_and_opportunityId_and_kind", (q) =>
      q.eq("tenantId", payment.tenantId).eq("opportunityId", opportunityId).eq("kind", "membership_deal"))
    .take(MEMBERSHIP_BINDING_LIMIT + 1);
  if (rows.length > MEMBERSHIP_BINDING_LIMIT) {
    throw expectedError("provider_payment.binding_limit", "Too many membership bindings to verify.");
  }
  for (const row of rows) {
    if (row.enabled && row.binding.kind === "membership_deal" && row.binding.anchorPaymentRecordId === record._id) {
      await ctx.db.patch("paymentProviderBindings", row._id, {
        enabled: false,
        disabledReason: "anchor_undone",
        version: row.version + 1,
      });
    }
  }
}

export const unlinkPaymentRecord = mutation({
  args: providerPaymentArgs,
  returns: v.null(),
  handler: async (ctx, { providerPaymentId }) => {
    const actor = await requireBillingPermission(ctx, "billing:correct");
    await requireBillingOpsEnabled(ctx, actor.tenantId);
    const payment = await requiredProviderPayment(ctx, actor.tenantId, providerPaymentId);
    if (!payment.paymentRecordId && payment.reviewState !== "linked") return null;
    if (payment.reviewState !== "linked" || !payment.paymentRecordId) {
      throw expectedError("provider_payment.not_manually_linked", "This provider payment has no manual link to remove.");
    }

    const record = await ctx.db.get("paymentRecords", payment.paymentRecordId);
    if (record?.tenantId !== actor.tenantId || record.providerPaymentId !== providerPaymentId) {
      throw expectedError("provider_payment.link_inconsistent", "The provider payment and CRM payment no longer refer to each other.");
    }
    await disableMembershipBindings(ctx, payment, record);
    await ctx.db.patch("paymentRecords", record._id, {
      providerPaymentId: undefined,
      providerPaidAt: undefined,
    });
    await ctx.db.patch("providerPayments", providerPaymentId, {
      paymentRecordId: undefined,
      opportunityId: undefined,
      leadId: undefined,
      matchMethod: undefined,
      reviewState: "needs_person",
      dismissReason: undefined,
      resolvedAt: undefined,
      resolvedByUserId: undefined,
    });
    await refreshProviderPaymentReview(ctx, providerPaymentId);
    await emitLinkEvent(ctx, "payment.provider_unlinked", actor, record._id, providerPaymentId);
    return null;
  },
});

export const dismissProviderPayment = mutation({
  args: { ...providerPaymentArgs, reason: dismissReasonValidator },
  returns: v.null(),
  handler: async (ctx, { providerPaymentId, reason }) => {
    const actor = await requireBillingPermission(ctx, "billing:review");
    await requireBillingOpsEnabled(ctx, actor.tenantId);
    const payment = await requiredProviderPayment(ctx, actor.tenantId, providerPaymentId);
    if (payment.reviewState === "dismissed") return null;
    if (payment.paymentRecordId || payment.reviewState !== "needs_person") {
      throw expectedError("provider_payment.not_reviewable", "This provider payment is not waiting for review.");
    }
    await ctx.db.patch("providerPayments", providerPaymentId, {
      reviewState: "dismissed",
      dismissReason: reason,
      resolvedAt: Date.now(),
      resolvedByUserId: actor.userId,
    });
    return null;
  },
});

export const reopenProviderPayment = mutation({
  args: providerPaymentArgs,
  returns: v.null(),
  handler: async (ctx, { providerPaymentId }) => {
    const actor = await requireBillingPermission(ctx, "billing:correct");
    await requireBillingOpsEnabled(ctx, actor.tenantId);
    const payment = await requiredProviderPayment(ctx, actor.tenantId, providerPaymentId);
    if (payment.reviewState === "needs_person" || payment.reviewState === "not_actionable") return null;
    if (payment.paymentRecordId || payment.reviewState !== "dismissed") {
      throw expectedError("provider_payment.not_dismissed", "This provider payment is not dismissed.");
    }
    await ctx.db.patch("providerPayments", providerPaymentId, {
      reviewState: "needs_person",
      dismissReason: undefined,
      resolvedAt: undefined,
      resolvedByUserId: undefined,
    });
    await refreshProviderPaymentReview(ctx, providerPaymentId);
    return null;
  },
});
