import { internal } from "../_generated/api";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx,
} from "../_generated/server";
import { log, reportError } from "../lib/observability/log";
import { providerPool } from "../pipeline/workpools";
import { noteWebhook } from "./connectionState";
import { refreshProviderPaymentReview } from "./match";
import { paymentProviderTables } from "./schema";
import { WhopRequestError } from "./whop/client";
import { WhopAccountMismatch, whopFetch } from "./whop/connectionFetch";
import {
  adverseEvent, disputeAlertSchema, disputeSchema, normalizePayment, paymentSchema, refundSchema,
  type AdverseEvent,
} from "./whop/normalize";

const connectionId = v.id("tenantPaymentConnections");
const receiptId = v.id("paymentWebhookReceipts");
const MAX_ATTEMPTS = 8;
const DAY_MS = 86_400_000;
const PAYER_RETENTION_MS = 90 * DAY_MS;
const receiptFields = paymentProviderTables.paymentWebhookReceipts.validator.fields;

async function findReceipt(
  ctx: QueryCtx | MutationCtx,
  connection: Doc<"tenantPaymentConnections">,
  webhookId: string,
) {
  return ctx.db.query("paymentWebhookReceipts")
    .withIndex("by_tenantId_and_connectionId_and_webhookId", (q) => q
      .eq("tenantId", connection.tenantId)
      .eq("connectionId", connection._id)
      .eq("webhookId", webhookId))
    .unique();
}

function findPayment(
  ctx: MutationCtx,
  connection: Doc<"tenantPaymentConnections">,
  externalPaymentId: string,
) {
  return ctx.db.query("providerPayments")
    .withIndex("by_tenantId_and_connectionId_and_externalPaymentId", (q) => q
      .eq("tenantId", connection.tenantId)
      .eq("connectionId", connection._id)
      .eq("externalPaymentId", externalPaymentId))
    .unique();
}

export const hasReceipt = internalQuery({
  args: { connectionId, tenantId: v.id("tenants"), webhookId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    return connection?.tenantId === args.tenantId &&
      (await findReceipt(ctx, connection, args.webhookId)) !== null;
  },
});

// Reserve a generation even when an adverse event is the first sight of the
// payment. Zero source timestamps identify this provisional, non-actionable row.
async function insertProvisionalPayment(
  ctx: MutationCtx,
  connection: Doc<"tenantPaymentConnections">,
  externalPaymentId: string,
  adverse?: { fencedAt: number; kind: AdverseEvent },
) {
  return ctx.db.insert("providerPayments", {
    tenantId: connection.tenantId,
    connectionId: connection._id,
    externalPaymentId,
    status: "unknown",
    sourceCreatedAt: 0,
    sourceUpdatedAt: 0,
    firstSeenAt: Date.now(),
    refreshGeneration: 1,
    currency: "",
    decimals: 0,
    refundedMinor: 0,
    adverseState: adverse ? pendingAdverseState(adverse.kind) : "none",
    adverseFencedAt: adverse?.fencedAt,
    lineItemCount: 0,
    failedAttemptCount: 0,
    reviewState: "not_actionable",
  });
}

function pendingAdverseState(kind: AdverseEvent) {
  return kind === "refund" ? "refund_pending" as const : "dispute_open" as const;
}

async function fencePayment(
  ctx: MutationCtx,
  connection: Doc<"tenantPaymentConnections">,
  externalPaymentId: string,
  kind: AdverseEvent,
  receivedAt?: number,
) {
  const existing = await findPayment(ctx, connection, externalPaymentId);
  const priorFence = existing?.adverseFencedAt ?? 0;
  const fencedAt = receivedAt ?? Math.max(Date.now(), priorFence + 1);
  if (fencedAt <= priorFence) return fencedAt;
  if (existing) {
    await ctx.db.patch("providerPayments", existing._id, {
      adverseFencedAt: fencedAt,
      ...(existing.adverseState === "none" ? { adverseState: pendingAdverseState(kind) } : {}),
      refreshGeneration: existing.refreshGeneration + 1,
    });
  } else {
    await insertProvisionalPayment(ctx, connection, externalPaymentId, { fencedAt, kind });
  }
  return fencedAt;
}

const attemptArgs = { receiptId, attempt: v.number() };

async function enqueueReceipt(
  ctx: MutationCtx,
  id: Id<"paymentWebhookReceipts">,
  attempt: number,
  runAfter = 0,
) {
  const context = { receiptId: id, attempt };
  await providerPool.enqueueAction(ctx, internal.payments.intake.processReceipt, context, {
    retry: false,
    runAfter,
    onComplete: internal.payments.intake.receiptWorkCompleted,
    context,
  });
}

export const receiveWebhook = internalMutation({
  args: {
    connectionId,
    tenantId: v.id("tenants"),
    accountId: v.string(),
    connectedAt: v.number(),
    webhookId: v.string(),
    eventType: v.string(),
    externalPaymentId: v.optional(v.string()),
    externalObjectId: v.optional(v.string()),
    bodySha256: v.string(),
    rawBodyStorageId: v.id("_storage"),
  },
  returns: v.union(v.literal("received"), v.literal("duplicate"), v.literal("unavailable")),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (
      !connection || connection.status === "disconnected" ||
      connection.tenantId !== args.tenantId || connection.accountId !== args.accountId ||
      connection.connectedAt !== args.connectedAt
    ) {
      await ctx.storage.delete(args.rawBodyStorageId);
      return "unavailable";
    }
    if (await findReceipt(ctx, connection, args.webhookId)) {
      await ctx.storage.delete(args.rawBodyStorageId);
      return "duplicate";
    }
    const now = Date.now();
    const kind = adverseEvent(args.eventType);
    const receivedAt = args.externalPaymentId && kind
      ? await fencePayment(ctx, connection, args.externalPaymentId, kind)
      : now;
    const failureCode = args.eventType === "unknown"
      ? "unknown_event"
      : args.externalObjectId ? undefined : "missing_object";
    const id = await ctx.db.insert("paymentWebhookReceipts", {
      tenantId: connection.tenantId,
      connectionId: connection._id,
      webhookId: args.webhookId,
      eventType: args.eventType,
      externalPaymentId: args.externalPaymentId,
      externalObjectId: args.externalObjectId,
      bodySha256: args.bodySha256,
      rawBodyStorageId: args.rawBodyStorageId,
      receivedAt,
      attempts: 0,
      status: failureCode ? "ignored" : "received",
      processedAt: failureCode ? now : undefined,
      failureCode,
    });
    await noteWebhook(ctx, connection, now);
    if (!failureCode) await enqueueReceipt(ctx, id, 1);
    return "received";
  },
});

export const receipt = internalQuery({
  args: { receiptId },
  returns: v.union(v.null(), v.object({
    ...receiptFields,
    _id: receiptId,
    _creationTime: v.number(),
  })),
  handler: (ctx, args) => ctx.db.get("paymentWebhookReceipts", args.receiptId),
});

const readIdentity = {
  connectionId,
  connectedAt: v.number(),
  accountId: v.string(),
  externalPaymentId: v.string(),
};

function isCurrentConnection(
  connection: Doc<"tenantPaymentConnections"> | null,
  args: { accountId: string; connectedAt: number },
): connection is Doc<"tenantPaymentConnections"> {
  return connection?.status === "connected" && connection.accountId === args.accountId &&
    connection.connectedAt === args.connectedAt;
}

const adverseKind = v.union(v.literal("refund"), v.literal("dispute"), v.literal("dispute_alert"));
export const beginPaymentRead = internalMutation({
  args: readIdentity,
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (!isCurrentConnection(connection, args)) return null;
    const row = await findPayment(ctx, connection, args.externalPaymentId);
    if (!row) {
      await insertProvisionalPayment(ctx, connection, args.externalPaymentId);
      return 1;
    }
    const generation = row.refreshGeneration + 1;
    await ctx.db.patch("providerPayments", row._id, { refreshGeneration: generation });
    return generation;
  },
});

const fields = paymentProviderTables.providerPayments.validator.fields;
const normalizedRead = v.object({
  externalPaymentId: fields.externalPaymentId,
  status: fields.status,
  substatus: fields.substatus,
  billingReason: fields.billingReason,
  sourceUpdatedAt: fields.sourceUpdatedAt,
  sourceCreatedAt: fields.sourceCreatedAt,
  paidAt: fields.paidAt,
  totalMinor: fields.totalMinor,
  currency: fields.currency,
  decimals: fields.decimals,
  buyerChargedMinor: fields.buyerChargedMinor,
  buyerChargedCurrency: fields.buyerChargedCurrency,
  refundedMinor: fields.refundedMinor,
  adverseState: fields.adverseState,
  refundedAt: fields.refundedAt,
  disputeCreatedAt: fields.disputeCreatedAt,
  membershipId: fields.membershipId,
  memberId: fields.memberId,
  providerUserId: fields.providerUserId,
  productId: fields.productId,
  variantId: fields.variantId,
  checkoutConfigurationId: fields.checkoutConfigurationId,
  productTitle: fields.productTitle,
  variantTitle: fields.variantTitle,
  lineItemCount: fields.lineItemCount,
  paymentMethodType: fields.paymentMethodType,
  financingInstallmentsCount: fields.financingInstallmentsCount,
  failedAttemptCount: fields.failedAttemptCount,
  declineCode: fields.declineCode,
  payerEmail: fields.payerEmail,
  payerPhone: fields.payerPhone,
});

const adverseEvidence = v.object({
  fencedAt: v.number(),
  kind: adverseKind,
  state: v.string(),
});

type PaymentFacts = typeof normalizedRead.type;
type AdverseEvidence = typeof adverseEvidence.type;

function explainsFence(
  row: Doc<"providerPayments">,
  payment: PaymentFacts,
  evidence?: AdverseEvidence,
) {
  if (payment.sourceUpdatedAt <= row.sourceUpdatedAt) return false;
  const refundChanged = payment.refundedMinor > row.refundedMinor ||
    (payment.refundedAt ?? 0) > (row.refundedAt ?? 0) ||
    (payment.adverseState === "refunded" && row.adverseState !== "refunded");
  const disputeChanged = payment.substatus !== row.substatus ||
    payment.adverseState !== row.adverseState ||
    (payment.disputeCreatedAt ?? 0) > (row.disputeCreatedAt ?? 0);
  const refunded = payment.adverseState === "refunded" ||
    payment.adverseState === "partially_refunded" || payment.refundedMinor > 0;
  if (!evidence) {
    // A sweep can explain a known pending reversal through a new payment
    // revision. Clearing to a final unencumbered state needs resource proof.
    if (row.adverseState === "refund_pending") return refunded && refundChanged;
    return row.adverseState === "dispute_open" && disputeChanged &&
      (payment.adverseState === "dispute_open" || payment.adverseState === "dispute_lost");
  }
  if (evidence.fencedAt !== row.adverseFencedAt) return false;
  if (evidence.kind === "refund")
    return evidence.state === "succeeded" && refunded && refundChanged;
  if (evidence.kind === "dispute_alert")
    return evidence.state === "auto_refunded"
      ? refunded && refundChanged
      : payment.adverseState === "dispute_open" && disputeChanged;
  switch (evidence.state) {
    case "won":
      return payment.substatus === "dispute_won" && disputeChanged;
    case "lost":
      return payment.adverseState === "dispute_lost" && disputeChanged;
    case "prevented":
      return refunded && refundChanged;
    case "warning_closed":
      return payment.substatus === "dispute_warning_closed" && disputeChanged;
    default:
      return payment.adverseState === "dispute_open" && disputeChanged;
  }
}

function reviewState(
  payment: PaymentFacts,
  autoImportAfter: number,
): Doc<"providerPayments">["reviewState"] {
  if (payment.status !== "paid") return "not_actionable";
  if (payment.paidAt !== undefined && payment.paidAt < autoImportAfter) return "historical";
  if (payment.totalMinor === 0) return "not_actionable";
  return "needs_person";
}

const readResult = v.union(
  v.literal("stored"), v.literal("fenced"), v.literal("stale"), v.literal("superseded"),
);

export const storePaymentRead = internalMutation({
  args: {
    ...readIdentity,
    generation: v.number(),
    payment: normalizedRead,
    evidence: v.optional(adverseEvidence),
  },
  returns: readResult,
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (!isCurrentConnection(connection, args)) return "superseded";
    const payment = args.payment;
    if (payment.externalPaymentId !== args.externalPaymentId) return "superseded";
    const row = await findPayment(ctx, connection, payment.externalPaymentId);
    if (!row || row.refreshGeneration !== args.generation) return "superseded";
    const pendingFence = row.adverseFencedAt !== undefined;
    if (payment.sourceUpdatedAt < row.sourceUpdatedAt) return pendingFence ? "fenced" : "stale";
    if (payment.sourceUpdatedAt === row.sourceUpdatedAt) {
      // Keep the prior snapshot as the comparison point for an unresolved
      // reversal. An equal revision also cannot undo a known reversal.
      if (pendingFence) return "fenced";
      if (row.adverseState !== "none" && (
        payment.adverseState !== row.adverseState || payment.refundedMinor < row.refundedMinor
      )) return "stale";
    }

    const fenced = pendingFence && !explainsFence(row, payment, args.evidence);
    const nextReviewState = reviewState(payment, connection.autoImportAfter);
    const protectedReview = row.reviewState === "linked" || row.reviewState === "recorded" ||
      row.reviewState === "dismissed";
    const now = Date.now();
    const expiredPayer = row.payerDetailsClearedAt !== undefined ||
      (row.resolvedAt !== undefined && row.resolvedAt <= now - PAYER_RETENTION_MS);

    // Convex omits undefined action arguments. Materialize fields that must
    // be removed when a later provider response no longer contains them.
    const factsPatch = { ...payment };
    for (const key of Object.keys(normalizedRead.fields))
      if (!(key in payment)) Object.assign(factsPatch, { [key]: undefined });
    await ctx.db.patch("providerPayments", row._id, {
      ...factsPatch,
      refreshedAt: now,
      adverseFencedAt: fenced ? row.adverseFencedAt : undefined,
      adverseState: fenced && row.adverseState !== "none" ? row.adverseState : payment.adverseState,
      payerEmail: expiredPayer ? undefined : payment.payerEmail,
      payerPhone: expiredPayer ? undefined : payment.payerPhone,
      payerDetailsClearedAt: expiredPayer ? row.payerDetailsClearedAt ?? now : undefined,
      ...(protectedReview ? {} : {
        reviewState: nextReviewState,
        ...(nextReviewState === "historical" ? {
          reviewReason: undefined,
          candidateLeadId: undefined,
          candidateOpportunityId: undefined,
          matchedAt: undefined,
        } : {}),
      }),
    });
    await refreshProviderPaymentReview(ctx, row._id);
    return fenced ? "fenced" : "stored";
  },
});

export async function refreshWhopPayment(
  ctx: ActionCtx,
  connection: Doc<"tenantPaymentConnections">,
  externalPaymentId: string,
  evidence?: AdverseEvidence,
): Promise<typeof readResult.type> {
  const identity = {
    connectionId: connection._id,
    connectedAt: connection.connectedAt,
    accountId: connection.accountId,
    externalPaymentId,
  };
  const generation = await ctx.runMutation(internal.payments.intake.beginPaymentRead, identity);
  if (generation === null) return "superseded";
  const payment = await whopFetch(ctx, connection._id, `/payments/${encodeURIComponent(externalPaymentId)}`, { connectedAt: connection.connectedAt }, (value) => {
    const parsed = paymentSchema.parse(value);
    if (parsed.account_id !== connection.accountId) throw new WhopAccountMismatch();
    if (parsed.id !== externalPaymentId) throw new WhopRequestError("unexpected_response");
    return normalizePayment(parsed);
  });
  return ctx.runMutation(internal.payments.intake.storePaymentRead, {
    ...identity, generation, payment, evidence,
  });
}

export const attachAdversePayment = internalMutation({
  args: { receiptId, externalPaymentId: v.string(), connectedAt: v.number() },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("paymentWebhookReceipts", args.receiptId);
    if (!row || row.status !== "received") return null;
    const kind = adverseEvent(row.eventType);
    if (!kind) return null;
    const connection = await ctx.db.get("tenantPaymentConnections", row.connectionId);
    if (
      connection?.status !== "connected" || connection.tenantId !== row.tenantId ||
      connection.connectedAt !== args.connectedAt
    ) return null;
    if (row.externalPaymentId) {
      return row.externalPaymentId === args.externalPaymentId ? row.receivedAt : null;
    }
    const fencedAt = await fencePayment(ctx, connection, args.externalPaymentId, kind, row.receivedAt);
    await ctx.db.patch("paymentWebhookReceipts", row._id, { externalPaymentId: args.externalPaymentId });
    return fencedAt;
  },
});

async function fetchAdverseResource(
  ctx: ActionCtx,
  connection: Doc<"tenantPaymentConnections">,
  event: NonNullable<ReturnType<typeof adverseEvent>>,
  externalObjectId: string,
) {
  const id = encodeURIComponent(externalObjectId);
  return whopFetch(ctx, connection._id, `/${event}s/${id}`, { connectedAt: connection.connectedAt }, (value) => {
    const object = event === "refund" ? refundSchema.parse(value)
      : event === "dispute" ? disputeSchema.parse(value)
      : disputeAlertSchema.parse(value);
    if (object.account_id !== connection.accountId) throw new WhopAccountMismatch();
    if (object.id !== externalObjectId) throw new WhopRequestError("unexpected_response");
    return {
      paymentId: "payment" in object ? object.payment.id : object.payment_id,
      state: "status" in object ? object.status : object.auto_refunded ? "auto_refunded" : "alerted",
    };
  });
}

const attemptOutcome = v.union(
  v.literal("processed"), v.literal("missing_object"), v.literal("account_mismatch"),
  v.literal("provider_read_failed"),
);

async function finishReceiptAttempt(
  ctx: MutationCtx,
  args: { receiptId: Id<"paymentWebhookReceipts">; attempt: number; outcome: typeof attemptOutcome.type; retryMs?: number },
) {
  const row = await ctx.db.get("paymentWebhookReceipts", args.receiptId);
  if (row?.status !== "received" || row.attempts + 1 !== args.attempt) return;
  const now = Date.now();
  if (args.outcome === "provider_read_failed" && args.attempt < MAX_ATTEMPTS) {
    const delay = Math.max(args.retryMs ?? 0, 5_000 * 2 ** (args.attempt - 1));
    await ctx.db.patch("paymentWebhookReceipts", row._id, {
      attempts: args.attempt,
      retryAt: now + delay,
      failureCode: "provider_read_failed",
    });
    await enqueueReceipt(ctx, row._id, args.attempt + 1, delay);
    return;
  }
  const status = args.outcome === "processed" ? "processed"
    : args.outcome === "provider_read_failed" ? "failed" : "ignored";
  await ctx.db.patch("paymentWebhookReceipts", row._id, {
    status,
    attempts: args.attempt,
    processedAt: now,
    retryAt: undefined,
    failureCode: args.outcome === "processed" ? undefined
      : args.outcome === "provider_read_failed" ? "attempts_exhausted" : args.outcome,
  });
  log.info("whop.webhook.completed", {
    connectionId: row.connectionId, receiptId: row._id, status, attempts: args.attempt,
  });
}

export const finishAttempt = internalMutation({
  args: { ...attemptArgs, outcome: attemptOutcome, retryMs: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await finishReceiptAttempt(ctx, args);
    return null;
  },
});

export const receiptWorkCompleted = internalMutation({
  args: vOnCompleteArgs(v.object(attemptArgs)),
  returns: v.null(),
  handler: async (ctx, { context, result }) => {
    if (result.kind !== "success")
      await finishReceiptAttempt(ctx, { ...context, outcome: "provider_read_failed" });
    return null;
  },
});

export const processReceipt = internalAction({
  args: attemptArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const receipt = await ctx.runQuery(internal.payments.intake.receipt, { receiptId: args.receiptId });
    if (receipt?.status !== "received" || receipt.attempts + 1 !== args.attempt) return null;
    const connection = await ctx.runQuery(internal.payments.connectionState.connection, {
      connectionId: receipt.connectionId,
    });
    let outcome: typeof attemptOutcome.type = "provider_read_failed";
    let retryMs: number | undefined;
    try {
      if (!connection || connection.tenantId !== receipt.tenantId)
        throw new WhopAccountMismatch();
      if (connection.status === "disconnected") {
        outcome = "missing_object";
      } else if (connection.status === "connected") {
        let externalPaymentId = receipt.externalPaymentId;
        let evidence: AdverseEvidence | undefined;
        const kind = adverseEvent(receipt.eventType);
        if (kind && receipt.externalObjectId) {
          const object = await fetchAdverseResource(ctx, connection, kind, receipt.externalObjectId);
          if (object.paymentId && externalPaymentId && object.paymentId !== externalPaymentId)
            throw new WhopRequestError("unexpected_response");
          externalPaymentId = object.paymentId ?? undefined;
          if (externalPaymentId) {
            const fencedAt = await ctx.runMutation(internal.payments.intake.attachAdversePayment, {
              receiptId: receipt._id, externalPaymentId, connectedAt: connection.connectedAt,
            });
            if (fencedAt === null) throw new WhopRequestError("unexpected_response");
            evidence = { kind, state: object.state, fencedAt };
          }
        }
        if (!externalPaymentId) {
          outcome = "missing_object";
        } else {
          const result = await refreshWhopPayment(ctx, connection, externalPaymentId, evidence);
          if (!kind || result === "stored" || result === "stale") outcome = "processed";
        }
      }
    } catch (error) {
      if (error instanceof WhopAccountMismatch) {
        outcome = "account_mismatch";
      } else if (error instanceof WhopRequestError) {
        retryMs = error.retryAfterMs;
      }
      if (outcome !== "account_mismatch") {
        reportError("whop.webhook.read_failed", new Error("Whop webhook payment read failed"), {
          integration: "whop", connectionId: receipt.connectionId, receiptId: receipt._id,
        });
      }
    }
    await ctx.runMutation(internal.payments.intake.finishAttempt, { ...args, outcome, retryMs });
    return null;
  },
});
