import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireBillingOpsEnabled, requireBillingPermission } from "../billing/guards";
import { followMergeChain } from "../leads/identityResolution";
import { emitDomainEvent } from "../lib/domainEvents";
import { leadDisplayString } from "../lib/leadDisplay";
import { expectedError } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import { paymentTypeValidator } from "../lib/paymentTypes";
import { dealOutcomeValidator, dealStageValidator } from "../opportunities/stages";
import { allocationChanged, clearActiveAllocation } from "./allocation";
import { findConnection } from "./connection";
import { adverseReviewRequired, releasePaymentFence } from "./intake";
import { findPaymentTarget, refreshProviderPaymentReview, type PaymentTarget } from "./match";
import { payerDetailsDeadline } from "./payerRetention";
import {
  paymentProviderTables,
  providerAdverseStateValidator,
  providerEnvironmentValidator,
  providerPaymentMatchMethodValidator,
  providerPaymentReviewReasonValidator,
  providerPaymentDismissReasonValidator,
} from "./schema";

const PAGE_LIMIT = 25;
const COUNT_LIMIT = 500;
const PERSON_DEAL_LIMIT = 100;
const MANUAL_PAYMENT_LIMIT = 50;
const MANUAL_PAYMENT_SCAN_LIMIT = 200;
const ALLOCATION_HISTORY_LIMIT = 40;

const providerPaymentIdValidator = v.id("providerPayments");
const paymentRecordIdValidator = v.id("paymentRecords");
const providerPaymentArgs = { providerPaymentId: providerPaymentIdValidator };
const nullableNumber = v.union(v.number(), v.null());
const nullableString = v.union(v.string(), v.null());

function reviewPageOptions(paginationOpts: typeof paginationOptsValidator.type) {
  return {
    ...paginationOpts,
    numItems: Math.min(PAGE_LIMIT, Math.max(1, Math.floor(paginationOpts.numItems) || 1)),
    maximumRowsRead: Math.min(PAGE_LIMIT, paginationOpts.maximumRowsRead ?? PAGE_LIMIT),
    maximumBytesRead: Math.min(2_000_000, paginationOpts.maximumBytesRead ?? 2_000_000),
  };
}

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

const exceptionState = v.union(
  v.literal("needs_person"), v.literal("linked"), v.literal("dismissed"), v.literal("historical"),
);

function exceptionQueue(
  ctx: QueryCtx,
  connection: Doc<"tenantPaymentConnections">,
  state: typeof exceptionState.type,
) {
  return ctx.db.query("providerPayments")
    .withIndex("by_connectionId_and_tenantId_and_reviewState_and_firstSeenAt", (q) => q
      .eq("connectionId", connection._id).eq("tenantId", connection.tenantId).eq("reviewState", state))
    .order("asc");
}

function adverseQueue(ctx: QueryCtx, connection: Doc<"tenantPaymentConnections">) {
  return ctx.db.query("providerPayments")
    .withIndex("by_connectionId_and_tenantId_and_adverseReviewAt", (q) => q
      .eq("connectionId", connection._id).eq("tenantId", connection.tenantId).gt("adverseReviewAt", undefined));
}

async function billingConnection(ctx: QueryCtx | MutationCtx, tenantId: Id<"tenants">) {
  const connections = await Promise.all([
    findConnection(ctx, tenantId, "live"), findConnection(ctx, tenantId, "sandbox"),
  ]);
  return connections.find((connection) => connection?.status === "connected") ?? null;
}

async function activePaymentSource(ctx: QueryCtx | MutationCtx, payment: Doc<"providerPayments">) {
  const connection = await billingConnection(ctx, payment.tenantId);
  return connection?._id === payment.connectionId ? connection : null;
}

async function requireActivePaymentSource(ctx: MutationCtx, payment: Doc<"providerPayments">) {
  if (!await activePaymentSource(ctx, payment)) {
    throw expectedError("provider_payment.connection_unavailable", "The Whop connection is unavailable.");
  }
}

function targetIds(target: PaymentTarget) {
  return target.kind === "needs_person"
    ? { leadId: target.candidateLeadId, dealIds: target.candidateOpportunityIds }
    : { leadId: target.leadId, dealIds: target.opportunityId ? [target.opportunityId] : [] };
}

function paymentForReview(payment: Doc<"providerPayments">, now: number) {
  if (payment.payerDetailsExpireAt === undefined || payment.payerDetailsExpireAt > now) return payment;
  return { ...payment, payerEmail: undefined, payerPhone: undefined };
}

async function canClassifyPageRow(ctx: QueryCtx) {
  const { bytesRead, databaseQueries, documentsRead } = await ctx.meta.getTransactionMetrics();
  // Leave room for one bounded matcher pass and for the returned row summaries.
  return bytesRead.remaining >= 4 * 1024 * 1024 &&
    databaseQueries.remaining >= 700 && documentsRead.remaining >= 2000;
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

export const listProviderExceptions = query({
  args: {
    paginationOpts: paginationOptsValidator,
    state: v.optional(exceptionState),
    asOf: v.optional(v.number()),
  },
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
      environment: providerEnvironmentValidator,
      classificationDeferred: v.boolean(),
      lastSuccessfulSweepAt: nullableNumber,
    })),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(nullableString),
    pageStatus: v.optional(v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())),
  }),
  handler: async (ctx, { paginationOpts, state = "needs_person", asOf = Date.now() }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const connection = await billingConnection(ctx, tenantId);
    if (!connection) return { page: [], isDone: true, continueCursor: "" };
    const page = await exceptionQueue(ctx, connection, state).paginate(reviewPageOptions(paginationOpts));
    const rows = [];
    for (const stored of page.page) {
      const payment = paymentForReview(stored, Date.now());
      const classificationDeferred = !(await canClassifyPageRow(ctx));
      const target = classificationDeferred ? null : await findPaymentTarget(ctx, payment, asOf);
      const ids = target ? targetIds(target) : {
        leadId: payment.candidateLeadId,
        dealIds: payment.candidateOpportunityId ? [payment.candidateOpportunityId] : [],
      };
      const [lead, deals] = await Promise.all([
        loadPerson(ctx, tenantId, ids.leadId),
        Promise.all(ids.dealIds.map((id) => ctx.db.get("opportunities", id))),
      ]);
      const deal = deals.find((deal) => lead && deal?.tenantId === tenantId && deal.leadId === lead._id);
      rows.push({
        providerPaymentId: payment._id,
        totalMinor: payment.totalMinor ?? null,
        currency: payment.currency,
        paidAt: payment.paidAt ?? null,
        firstSeenAt: payment.firstSeenAt,
        productTitle: payment.productTitle ?? null,
        variantTitle: payment.variantTitle ?? null,
        reviewReason: target?.kind === "ready" ? "ready" as const
          : target?.kind === "needs_person" ? target.reason : payment.reviewReason ?? null,
        payerEmail: payment.payerEmail ?? null,
        candidatePerson: personSummary(lead),
        candidateDeal: deal ? dealSummary(deal) : null,
        environment: connection.environment,
        classificationDeferred,
        lastSuccessfulSweepAt: connection.lastSuccessfulSweepAt ?? null,
      });
    }
    return { ...page, page: rows };
  },
});

export const getProviderExceptionCounts = query({
  args: {},
  returns: v.object({
    count: v.number(), capped: v.boolean(),
    adverseCount: v.number(), adverseCapped: v.boolean(), connected: v.boolean(),
    environment: v.union(providerEnvironmentValidator, v.null()),
    lastSuccessfulSweepAt: nullableNumber,
  }),
  handler: async (ctx) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const connection = await billingConnection(ctx, tenantId);
    const [rows, adverse] = connection ? await Promise.all([
      exceptionQueue(ctx, connection, "needs_person").take(COUNT_LIMIT + 1),
      adverseQueue(ctx, connection).take(COUNT_LIMIT + 1),
    ]) : [[], []];
    return {
      count: Math.min(rows.length, COUNT_LIMIT), capped: rows.length > COUNT_LIMIT,
      adverseCount: Math.min(adverse.length, COUNT_LIMIT), adverseCapped: adverse.length > COUNT_LIMIT,
      connected: connection !== null, environment: connection?.environment ?? null,
      lastSuccessfulSweepAt: connection?.lastSuccessfulSweepAt ?? null,
    };
  },
});

export const listAdverseOnResolved = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(v.object({
      providerPaymentId: providerPaymentIdValidator,
      paymentRecordId: paymentRecordIdValidator,
      totalMinor: nullableNumber,
      currency: v.string(),
      adverseState: providerAdverseStateValidator,
      adverseReviewRevision: v.number(),
      environment: providerEnvironmentValidator,
    })),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(nullableString),
    pageStatus: v.optional(v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())),
  }),
  handler: async (ctx, { paginationOpts }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const connection = await billingConnection(ctx, tenantId);
    if (!connection) return { page: [], isDone: true, continueCursor: "" };
    const page = await adverseQueue(ctx, connection).paginate(reviewPageOptions(paginationOpts));
    return { ...page, page: page.page.flatMap((payment) => payment.paymentRecordId ? [{
      providerPaymentId: payment._id,
      paymentRecordId: payment.paymentRecordId,
      totalMinor: payment.totalMinor ?? null,
      currency: payment.currency,
      adverseState: payment.adverseState,
      adverseReviewRevision: payment.adverseReviewRevision,
      environment: connection.environment,
    }] : []) };
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
  args: { ...providerPaymentArgs, leadId: v.optional(v.id("leads")), asOf: v.optional(v.number()) },
  returns: v.union(v.null(), v.object({
    payment: providerPaymentValidator,
    classification: targetValidator,
    candidatePerson: v.union(personSummaryValidator, v.null()),
    candidateDeals: v.array(dealSummaryValidator),
    manualPayments: v.array(manualPaymentValidator),
    manualPaymentsCapped: v.boolean(),
    environment: providerEnvironmentValidator,
    resolvedByName: nullableString,
    allocationRevision: v.number(),
    lastSuccessfulSweepAt: nullableNumber,
  })),
  handler: async (ctx, { providerPaymentId, leadId, asOf = Date.now() }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const stored = await ctx.db.get("providerPayments", providerPaymentId);
    if (stored?.tenantId !== tenantId) return null;
    const connection = await activePaymentSource(ctx, stored);
    if (!connection) return null;
    const payment = paymentForReview(stored, Date.now());
    const classification = await findPaymentTarget(ctx, payment, asOf);
    const ids = targetIds(classification);
    const [lead, deals, resolver, selectedPerson] = await Promise.all([
      loadPerson(ctx, tenantId, ids.leadId),
      Promise.all(ids.dealIds.map((id) => ctx.db.get("opportunities", id))),
      payment.resolvedByUserId ? ctx.db.get("users", payment.resolvedByUserId) : null,
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
      environment: connection.environment,
      allocationRevision: payment.allocationRevision,
      lastSuccessfulSweepAt: connection.lastSuccessfulSweepAt ?? null,
      resolvedByName: resolver?.tenantId === tenantId ? resolver.fullName?.trim() || resolver.email : null,
    };
  },
});

/** Old evidence remains readable after disconnect or after switching environments. */
export const getArchivedProviderPayment = query({
  args: providerPaymentArgs,
  returns: v.union(v.null(), v.object({
    payment: providerPaymentValidator,
    environment: providerEnvironmentValidator,
  })),
  handler: async (ctx, { providerPaymentId }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const payment = await ctx.db.get("providerPayments", providerPaymentId);
    if (payment?.tenantId !== tenantId || await activePaymentSource(ctx, payment)) return null;
    const connection = await ctx.db.get("tenantPaymentConnections", payment.connectionId);
    if (connection?.tenantId !== tenantId) return null;
    return {
      payment: paymentForReview(payment, Date.now()),
      environment: connection.environment,
    };
  },
});

/** The evidence attached to a CRM payment, including retained provenance. */
export const getLinkedProviderPayment = query({
  args: { paymentRecordId: paymentRecordIdValidator },
  returns: v.union(v.object({
    ...providerPaymentValidator.fields,
    environment: providerEnvironmentValidator,
    sourceConnected: v.boolean(),
  }), v.null()),
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const record = await ctx.db.get("paymentRecords", paymentRecordId);
    if (record?.tenantId !== tenantId || !record.providerPaymentId) return null;
    const payment = await ctx.db.get("providerPayments", record.providerPaymentId);
    if (payment?.tenantId !== tenantId) return null;
    const [connection, activeSource] = await Promise.all([
      ctx.db.get("tenantPaymentConnections", payment.connectionId),
      activePaymentSource(ctx, payment),
    ]);
    if (connection?.tenantId !== tenantId) return null;
    return {
      ...paymentForReview(payment, Date.now()),
      environment: connection.environment,
      sourceConnected: activeSource !== null,
    };
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
  eventType: "payment.provider_linked" | "payment.provider_unlinked" | "payment.provider_adverse_acknowledged",
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

const allocationState = v.object({
  allocationRevision: v.number(),
  paymentRecordId: v.union(paymentRecordIdValidator, v.null()),
});

export const linkToPaymentRecord = mutation({
  args: {
    ...providerPaymentArgs,
    paymentRecordId: paymentRecordIdValidator,
    acknowledgedAmounts: v.optional(v.object({ crmAmountMinor: v.number(), providerTotalMinor: v.number() })),
    expectedAllocationRevision: v.number(),
  },
  returns: allocationState,
  handler: async (ctx, { providerPaymentId, paymentRecordId, acknowledgedAmounts, expectedAllocationRevision }) => {
    const actor = await requireBillingPermission(ctx, "billing:review");
    await requireBillingOpsEnabled(ctx, actor.tenantId);
    const payment = await requiredProviderPayment(ctx, actor.tenantId, providerPaymentId);
    await requireActivePaymentSource(ctx, payment);
    if (payment.paymentRecordId === paymentRecordId) {
      return { allocationRevision: payment.allocationRevision, paymentRecordId };
    }
    if (payment.allocationRevision !== expectedAllocationRevision) throw allocationChanged();
    const record = await ctx.db.get("paymentRecords", paymentRecordId);
    if (record?.tenantId !== actor.tenantId) throw expectedError("provider_payment.record_not_found", "CRM payment not found.");

    if (payment.paymentRecordId || payment.reviewState === "linked" || payment.reviewState === "recorded") {
      throw expectedError("provider_payment.already_allocated", "This provider payment has an active allocation.");
    }
    if (payment.reviewState === "dismissed") throw expectedError("provider_payment.dismissed", "Reopen this provider payment first.");
    if (payment.status !== "paid") throw expectedError("provider_payment.not_paid", "The provider has not marked this payment paid.");
    if (record.status === "disputed") throw expectedError("provider_payment.record_disputed", "This CRM payment is disputed.");
    if (record.providerPaymentId) throw expectedError("provider_payment.record_already_linked", "This CRM payment already has provider evidence.");
    if (payment.currency !== record.currency) throw expectedError("provider_payment.currency_mismatch", "The payment currencies differ.");
    if (payment.totalMinor === undefined) throw expectedError("provider_payment.unsupported_currency", "The provider amount is unavailable.");
    if (payment.totalMinor !== record.amountMinor &&
        (acknowledgedAmounts?.crmAmountMinor !== record.amountMinor ||
          acknowledgedAmounts.providerTotalMinor !== payment.totalMinor)) {
      throw new ConvexError({
        code: "provider_payment.amount_mismatch",
        message: "Confirm the difference between the two amounts.",
        crmAmountMinor: record.amountMinor,
        providerTotalMinor: payment.totalMinor,
      });
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
    const resolvedAt = Date.now();
    const allocationRevision = payment.allocationRevision + 1;
    const reviewAdverse = adverseReviewRequired(payment);
    await ctx.db.patch("providerPayments", providerPaymentId, {
      paymentRecordId,
      allocationRevision,
      adverseReviewAt: reviewAdverse ? resolvedAt : undefined,
      adverseReviewRevision: payment.adverseReviewRevision + (reviewAdverse ? 1 : 0),
      opportunityId: deal._id,
      leadId: lead._id,
      matchMethod: "person",
      reviewState: "linked",
      reviewReason: undefined,
      resolvedAt,
      payerDetailsExpireAt: payerDetailsDeadline(payment, "needs_person", resolvedAt),
      resolvedByUserId: actor.userId,
    });
    await emitLinkEvent(ctx, "payment.provider_linked", actor, paymentRecordId, providerPaymentId);
    return { allocationRevision, paymentRecordId };
  },
});

export const unlinkPaymentRecord = mutation({
  args: {
    ...providerPaymentArgs,
    expectedPaymentRecordId: paymentRecordIdValidator,
    expectedAllocationRevision: v.number(),
  },
  returns: allocationState,
  handler: async (ctx, { providerPaymentId, expectedPaymentRecordId, expectedAllocationRevision }) => {
    const actor = await requireBillingPermission(ctx, "billing:correct");
    await requireBillingOpsEnabled(ctx, actor.tenantId);
    const payment = await requiredProviderPayment(ctx, actor.tenantId, providerPaymentId);
    if (payment.paymentRecordId === undefined && payment.allocationRevision === expectedAllocationRevision + 1) {
      return { allocationRevision: payment.allocationRevision, paymentRecordId: null };
    }
    if (payment.allocationRevision !== expectedAllocationRevision ||
        payment.paymentRecordId !== expectedPaymentRecordId) throw allocationChanged();
    if (payment.reviewState !== "linked") {
      throw expectedError("provider_payment.not_manually_linked", "This provider payment has no manual link to remove.");
    }

    const record = await ctx.db.get("paymentRecords", expectedPaymentRecordId);
    if (record?.tenantId !== actor.tenantId || record.providerPaymentId !== providerPaymentId) {
      throw expectedError("provider_payment.link_inconsistent", "The provider payment and CRM payment no longer refer to each other.");
    }
    // A manual unlink corrects the provenance itself.
    await ctx.db.patch("paymentRecords", record._id, {
      providerPaymentId: undefined,
      providerPaidAt: undefined,
    });
    await clearActiveAllocation(ctx, record);
    await emitLinkEvent(ctx, "payment.provider_unlinked", actor, record._id, providerPaymentId);
    return { allocationRevision: payment.allocationRevision + 1, paymentRecordId: null };
  },
});

export const acknowledgeAdverse = mutation({
  args: {
    ...providerPaymentArgs,
    expectedAdverseReviewRevision: v.number(),
    expectedPaymentRecordId: paymentRecordIdValidator,
  },
  returns: v.null(),
  handler: async (ctx, { providerPaymentId, expectedAdverseReviewRevision, expectedPaymentRecordId }) => {
    const actor = await requireBillingPermission(ctx, "billing:review");
    await requireBillingOpsEnabled(ctx, actor.tenantId);
    const payment = await requiredProviderPayment(ctx, actor.tenantId, providerPaymentId);
    await requireActivePaymentSource(ctx, payment);
    if (payment.paymentRecordId !== expectedPaymentRecordId ||
        payment.adverseReviewRevision !== expectedAdverseReviewRevision) throw allocationChanged();
    if (payment.adverseReviewAt === undefined) return null;
    await ctx.db.patch("providerPayments", payment._id, { adverseReviewAt: undefined });
    await emitLinkEvent(ctx, "payment.provider_adverse_acknowledged", actor, expectedPaymentRecordId, providerPaymentId);
    return null;
  },
});

export const releaseAdverseHold = mutation({
  args: providerPaymentArgs,
  returns: v.null(),
  handler: async (ctx, { providerPaymentId }) => {
    const actor = await requireBillingPermission(ctx, "billing:correct");
    await requireBillingOpsEnabled(ctx, actor.tenantId);
    const payment = await requiredProviderPayment(ctx, actor.tenantId, providerPaymentId);
    await requireActivePaymentSource(ctx, payment);
    if (payment.adverseFencedAt === undefined) {
      throw expectedError("provider_payment.hold_already_cleared", "This Whop hold has already cleared.");
    }
    await releasePaymentFence(ctx, payment);
    await emitDomainEvent(ctx, {
      tenantId: actor.tenantId,
      entityType: "payment",
      entityId: payment.paymentRecordId ?? payment._id,
      eventType: "payment.provider_hold_released",
      source: "admin",
      actorUserId: actor.userId,
      metadata: { providerPaymentId, paymentRecordId: payment.paymentRecordId },
    });
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
    await requireActivePaymentSource(ctx, payment);
    if (payment.reviewState === "dismissed") return null;
    if (payment.paymentRecordId || payment.reviewState !== "needs_person") {
      throw expectedError("provider_payment.not_reviewable", "This provider payment is not waiting for review.");
    }
    const resolvedAt = Date.now();
    await ctx.db.patch("providerPayments", providerPaymentId, {
      reviewState: "dismissed",
      dismissReason: reason,
      resolvedAt,
      payerDetailsExpireAt: payerDetailsDeadline(payment, "needs_person", resolvedAt),
      resolvedByUserId: actor.userId,
    });
    log.info("whop.payment.dismissed", { tenantId: actor.tenantId, providerPaymentId, userId: actor.userId, reason });
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
    await requireActivePaymentSource(ctx, payment);
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
    log.info("whop.payment.reopened", { tenantId: actor.tenantId, providerPaymentId, userId: actor.userId });
    return null;
  },
});
