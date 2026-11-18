import { internal } from "../_generated/api";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx,
} from "../_generated/server";
import { log } from "../lib/observability/log";
import { providerPool } from "../pipeline/workpools";
import { noteWebhook } from "./connectionState";
import { baseProviderReviewState, refreshProviderPaymentReview } from "./match";
import { payerDetailsDeadline } from "./payerRetention";
import { paymentProviderTables, RAW_RECEIPT_BATCH } from "./schema";
import { MAX_RETRY_AFTER_MS, reportWhopRequestError, WhopRequestError } from "./whop/client";
import { WhopAccountMismatch, whopFetch } from "./whop/connectionFetch";
import {
  adverseEvent, disputeAlertSchema, disputeSchema, normalizePayment, paymentSchema, refundSchema,
  type AdverseEvent,
} from "./whop/normalize";

const connectionId = v.id("tenantPaymentConnections");
const receiptId = v.id("paymentWebhookReceipts");
const MAX_ATTEMPTS = 8;
const {
  tenantId: receiptTenantId, connectionId: receiptConnectionId, eventType: receiptEventType,
  externalPaymentId: receiptExternalPaymentId, externalObjectId: receiptExternalObjectId,
  attempts: receiptAttempts, status: receiptStatus, adversePending: receiptAdversePending,
} = paymentProviderTables.paymentWebhookReceipts.validator.fields;

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
    allocationRevision: 0,
    adverseReviewRevision: 0,
    currency: "",
    decimals: 0,
    refundedMinor: 0,
    adverseState: adverse ? pendingAdverseState(adverse.kind) : "none",
    sourceAdverseState: "none",
    adverseFencedAt: adverse?.fencedAt,
    lineItemCount: 0,
    failedAttemptCount: 0,
    reviewState: "not_actionable",
  });
}

function pendingAdverseState(kind: AdverseEvent) {
  return kind === "refund" ? "refund_pending" as const : "dispute_open" as const;
}

async function fenceForReceipt(
  ctx: MutationCtx,
  connection: Doc<"tenantPaymentConnections">,
  externalPaymentId: string,
  externalObjectId: string,
  kind: AdverseEvent,
  receivedAt: number,
) {
  const [existing, seen] = await Promise.all([
    findPayment(ctx, connection, externalPaymentId),
    ctx.db.query("paymentWebhookReceipts")
      .withIndex("by_connectionId_and_externalPaymentId_and_externalObjectId", (q) => q
        .eq("connectionId", connection._id)
        .eq("externalPaymentId", externalPaymentId)
        .eq("externalObjectId", externalObjectId))
      .first(),
  ]);
  const fencedAt = Math.max(receivedAt, existing?.adverseFencedAt ?? 0);
  if (existing) {
    const sourceAdverseState = existing.sourceAdverseState ?? existing.adverseState;
    const adverseState = sourceAdverseState === "none" || sourceAdverseState === "dispute_won"
      ? pendingAdverseState(kind) : sourceAdverseState;
    await ctx.db.patch("providerPayments", existing._id, {
      adverseFencedAt: fencedAt,
      sourceAdverseState,
      adverseState,
      ...adverseReviewUpdate(existing, {
        adverseState, adverseFencedAt: fencedAt, refundedMinor: existing.refundedMinor,
      }, receivedAt, seen === null),
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
    rawBody: v.string(),
  },
  returns: v.union(v.literal("received"), v.literal("duplicate"), v.literal("unavailable")),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (
      !connection || connection.status === "disconnected" ||
      connection.tenantId !== args.tenantId || connection.accountId !== args.accountId ||
      connection.connectedAt !== args.connectedAt
    ) {
      return "unavailable";
    }
    if (await findReceipt(ctx, connection, args.webhookId)) {
      return "duplicate";
    }
    const now = Date.now();
    const kind = adverseEvent(args.eventType);
    const failureCode = args.eventType === "unknown"
      ? "unknown_event"
      : args.externalObjectId ? undefined : "missing_object";
    const adversePending = kind !== undefined && !failureCode;
    const unavailable = connection.status !== "connected";
    if (kind && adversePending && args.externalPaymentId && args.externalObjectId) {
      await fenceForReceipt(ctx, connection, args.externalPaymentId, args.externalObjectId, kind, now);
    }
    const id = await ctx.db.insert("paymentWebhookReceipts", {
      tenantId: connection.tenantId,
      connectionId: connection._id,
      webhookId: args.webhookId,
      eventType: args.eventType,
      externalPaymentId: args.externalPaymentId,
      externalObjectId: args.externalObjectId,
      bodySha256: args.bodySha256,
      rawBody: args.rawBody,
      hasRawBody: true,
      adversePending: adversePending || undefined,
      receivedAt: now,
      attempts: 0,
      status: failureCode ? "ignored" : unavailable ? "failed" : "received",
      processedAt: failureCode || unavailable ? now : undefined,
      failureCode: failureCode ?? (unavailable ? "connection_unavailable" : undefined),
    });
    await noteWebhook(ctx, connection, now);
    if (!failureCode && !unavailable) await enqueueReceipt(ctx, id, 1);
    return "received";
  },
});

export const receipt = internalQuery({
  args: { receiptId },
  returns: v.union(v.null(), v.object({
    _id: receiptId,
    tenantId: receiptTenantId,
    connectionId: receiptConnectionId,
    eventType: receiptEventType,
    externalPaymentId: receiptExternalPaymentId,
    externalObjectId: receiptExternalObjectId,
    attempts: receiptAttempts,
    status: receiptStatus,
    adversePending: receiptAdversePending,
  })),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("paymentWebhookReceipts", args.receiptId);
    if (!row) return null;
    const { _id, tenantId, connectionId, eventType, externalPaymentId, externalObjectId,
      attempts, status, adversePending } = row;
    return { _id, tenantId, connectionId, eventType, externalPaymentId, externalObjectId,
      attempts, status, adversePending };
  },
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
  receiptId,
  kind: adverseKind,
  state: v.string(),
  updatedAt: v.number(),
  refundMinor: v.optional(v.number()),
});

type PaymentFacts = typeof normalizedRead.type;
type AdverseEvidence = typeof adverseEvidence.type;

function corroboratesResource(payment: PaymentFacts, evidence: AdverseEvidence) {
  const refunded = payment.adverseState === "refunded" ||
    payment.adverseState === "partially_refunded" || Math.abs(payment.refundedMinor) > 0;
  const reflectedRefund = refunded &&
    (payment.refundedAt ?? payment.sourceUpdatedAt) >= evidence.updatedAt &&
    (evidence.refundMinor === undefined || Math.abs(payment.refundedMinor) >= Math.abs(evidence.refundMinor));
  if (evidence.kind === "refund") {
    if (evidence.state === "failed" || evidence.state === "canceled") {
      return payment.adverseState === "none" && payment.refundedMinor === 0;
    }
    return evidence.state === "succeeded" && reflectedRefund;
  }
  if (evidence.kind === "dispute_alert") {
    return evidence.state === "auto_refunded" ? reflectedRefund : payment.adverseState === "dispute_open";
  }
  switch (evidence.state) {
    case "won": return payment.substatus === "dispute_won";
    case "lost": return payment.adverseState === "dispute_lost";
    case "prevented": return reflectedRefund;
    case "warning_closed": return payment.substatus === "dispute_warning_closed";
    default: return payment.adverseState === "dispute_open";
  }
}

function pendingAdverseReceipts(
  ctx: QueryCtx | MutationCtx,
  connectionId: Id<"tenantPaymentConnections">,
  externalPaymentId: string,
  through?: number,
) {
  return ctx.db.query("paymentWebhookReceipts")
    .withIndex("by_connectionId_and_externalPaymentId_and_adversePending", (q) => {
      const range = q.eq("connectionId", connectionId)
        .eq("externalPaymentId", externalPaymentId)
        .eq("adversePending", true);
      return through === undefined ? range : range.lte("_creationTime", through);
    });
}

type AdverseFacts = Pick<Doc<"providerPayments">, "adverseState" | "adverseFencedAt" | "refundedMinor">;

export function adverseReviewRequired({ adverseState, adverseFencedAt }: AdverseFacts) {
  return adverseFencedAt !== undefined || (adverseState !== "none" && adverseState !== "dispute_won");
}

function adverseReviewUpdate(
  row: Doc<"providerPayments">,
  next: AdverseFacts,
  now: number,
  newAdverseFact: boolean,
) {
  if (!row.paymentRecordId || (row.reviewState !== "linked" && row.reviewState !== "recorded")) return {};
  if (!adverseReviewRequired(next)) {
    return row.adverseReviewAt === undefined ? {} : {
      adverseReviewAt: undefined, adverseReviewRevision: row.adverseReviewRevision + 1,
    };
  }
  if (newAdverseFact || next.adverseState !== row.adverseState ||
      Math.abs(next.refundedMinor) > Math.abs(row.refundedMinor)) {
    return {
      adverseReviewAt: row.adverseReviewAt ?? now,
      adverseReviewRevision: row.adverseReviewRevision + 1,
    };
  }
  return {};
}

const readResult = v.union(
  v.literal("stored"), v.literal("fenced"), v.literal("stale"), v.literal("superseded"),
  v.literal("covered"),
);

export const storePaymentRead = internalMutation({
  args: {
    ...readIdentity,
    generation: v.number(),
    payment: normalizedRead,
    evidence: v.optional(v.array(adverseEvidence)),
  },
  returns: readResult,
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (!isCurrentConnection(connection, args)) return "superseded";
    const payment = args.payment;
    if (payment.externalPaymentId !== args.externalPaymentId) return "superseded";
    const row = await findPayment(ctx, connection, payment.externalPaymentId);
    if (!row) return "superseded";
    if (row.refreshGeneration !== args.generation) {
      return (row.storedRefreshGeneration ?? 0) > args.generation &&
        row.sourceUpdatedAt >= payment.sourceUpdatedAt ? "covered" : "superseded";
    }
    if (payment.sourceUpdatedAt < row.sourceUpdatedAt) {
      return row.adverseFencedAt !== undefined ? "fenced" : "stale";
    }
    const confirmed = [];
    for (const evidence of args.evidence ?? []) {
      if (!corroboratesResource(payment, evidence)) continue;
      const receipt = await ctx.db.get("paymentWebhookReceipts", evidence.receiptId);
      if (receipt?.adversePending && receipt.connectionId === connection._id &&
          receipt.externalPaymentId === payment.externalPaymentId &&
          adverseEvent(receipt.eventType) === evidence.kind) {
        confirmed.push({ receipt, evidence });
      }
    }
    const sourceAdverseState = row.sourceAdverseState ?? row.adverseState;
    const confirmsCleanRefund = sourceAdverseState === "refund_pending" && payment.adverseState === "none" &&
      confirmed.some(({ evidence }) => evidence.kind === "refund" &&
        (evidence.state === "failed" || evidence.state === "canceled"));
    if (payment.sourceUpdatedAt === row.sourceUpdatedAt && !confirmsCleanRefund && (
      (row.adverseFencedAt !== undefined || sourceAdverseState !== "none") &&
      (payment.adverseState !== sourceAdverseState || Math.abs(payment.refundedMinor) < Math.abs(row.refundedMinor))
    )) return row.adverseFencedAt !== undefined ? "fenced" : "stale";

    for (const { receipt } of confirmed) {
      await ctx.db.patch("paymentWebhookReceipts", receipt._id, { adversePending: undefined });
    }
    const pending = row.adverseFencedAt === undefined ? null
      : await pendingAdverseReceipts(ctx, connection._id, payment.externalPaymentId).order("desc").first();
    const pendingKind = pending && adverseEvent(pending.eventType);
    const adverseState = pendingKind &&
      (payment.adverseState === "none" || payment.adverseState === "dispute_won")
      ? pendingAdverseState(pendingKind)
      : payment.adverseState;
    const adverseFencedAt = pending ? row.adverseFencedAt : undefined;
    const nextReviewState = baseProviderReviewState(payment, connection.autoImportAfter);
    const protectedReview = row.reviewState === "linked" || row.reviewState === "recorded" ||
      row.reviewState === "dismissed";
    const now = Date.now();
    const payerDetailsExpireAt = payerDetailsDeadline(
      row, protectedReview ? row.reviewState : nextReviewState, row.resolvedAt,
    );
    const expiredPayer = row.payerDetailsClearedAt !== undefined || now >= payerDetailsExpireAt;

    // Convex omits undefined action arguments. Materialize fields that must
    // be removed when a later provider response no longer contains them.
    const factsPatch = { ...payment };
    for (const key of Object.keys(normalizedRead.fields))
      if (!(key in payment)) Object.assign(factsPatch, { [key]: undefined });
    await ctx.db.patch("providerPayments", row._id, {
      ...factsPatch,
      refreshedAt: now,
      storedRefreshGeneration: args.generation,
      adverseFencedAt,
      adverseState,
      sourceAdverseState: payment.adverseState,
      ...adverseReviewUpdate(row, {
        adverseState, adverseFencedAt, refundedMinor: payment.refundedMinor,
      }, now, payment.adverseState !== sourceAdverseState),
      payerDetailsExpireAt,
      hasPayerDetails: !expiredPayer && Boolean(payment.payerEmail || payment.payerPhone) || undefined,
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
    if (connection.unreadablePaymentIds?.includes(payment.externalPaymentId)) {
      await ctx.db.patch("tenantPaymentConnections", connection._id, {
        unreadablePaymentIds: connection.unreadablePaymentIds.filter((id) => id !== payment.externalPaymentId),
      });
    }
    await refreshProviderPaymentReview(ctx, row._id);
    return pending ? "fenced" : "stored";
  },
});

export async function refreshWhopPayment(
  ctx: ActionCtx,
  connection: Doc<"tenantPaymentConnections">,
  externalPaymentId: string,
  evidence?: AdverseEvidence[],
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
    if (!row.adversePending || !row.externalObjectId) return null;
    const fencedAt = await fenceForReceipt(
      ctx, connection, args.externalPaymentId, row.externalObjectId, kind, row.receivedAt,
    );
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
    const amount = "amount" in object ? object.amount : undefined;
    const refundMagnitude = amount ? (amount.minor < 0n ? -amount.minor : amount.minor) : undefined;
    return {
      paymentId: "payment" in object ? object.payment.id : object.payment_id,
      state: "status" in object ? object.status : object.auto_refunded ? "auto_refunded" : "alerted",
      updatedAt: object.updated_at,
      refundMinor: amount?.decimals === 2 && refundMagnitude !== undefined &&
        refundMagnitude <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(refundMagnitude) : undefined,
    };
  });
}

export const listPendingAdverse = internalQuery({
  args: { connectionId, externalPaymentId: v.string() },
  returns: v.array(v.object({ receiptId, kind: adverseKind, externalObjectId: v.string() })),
  handler: async (ctx, { connectionId, externalPaymentId }) => {
    const rows = await pendingAdverseReceipts(ctx, connectionId, externalPaymentId).take(8);
    return rows.flatMap((row) => {
      const kind = adverseEvent(row.eventType);
      return kind && row.externalObjectId ? [{
        receiptId: row._id, kind, externalObjectId: row.externalObjectId,
      }] : [];
    });
  },
});

export async function refreshWhopPaymentForSweep(
  ctx: ActionCtx,
  connection: Doc<"tenantPaymentConnections">,
  externalPaymentId: string,
) {
  const resources = await ctx.runQuery(internal.payments.intake.listPendingAdverse, {
    connectionId: connection._id, externalPaymentId,
  });
  const evidence: AdverseEvidence[] = [];
  for (const resource of resources) {
    try {
      const object = await fetchAdverseResource(ctx, connection, resource.kind, resource.externalObjectId);
      if (object.paymentId === externalPaymentId) evidence.push({ ...resource, ...object });
    } catch (error) {
      // An inaccessible resource must not prevent the canonical payment read.
      if (!(error instanceof WhopRequestError) ||
          (error.code !== "forbidden" && error.code !== "unexpected_response")) throw error;
    }
  }
  return refreshWhopPayment(ctx, connection, externalPaymentId, evidence.map(
    ({ receiptId, kind, state, updatedAt, refundMinor }) => ({ receiptId, kind, state, updatedAt, refundMinor }),
  ));
}

async function resolveReleasedReceipts(
  ctx: MutationCtx,
  payment: Doc<"providerPayments">,
  through?: number,
) {
  const { _id: providerPaymentId, connectionId, externalPaymentId } = payment;
  const receipts = through === undefined ? [] : await pendingAdverseReceipts(
    ctx, connectionId, externalPaymentId, through,
  ).take(RAW_RECEIPT_BATCH + 1);
  const now = Date.now();
  for (const receipt of receipts.slice(0, RAW_RECEIPT_BATCH)) {
    await ctx.db.patch("paymentWebhookReceipts", receipt._id, {
      adversePending: undefined,
      status: "processed",
      failureCode: "released_by_person",
      processedAt: now,
      retryAt: undefined,
    });
  }
  if (through !== undefined && receipts.length > RAW_RECEIPT_BATCH) {
    await ctx.scheduler.runAfter(0, internal.payments.intake.continueAdverseRelease, { providerPaymentId, through });
  } else {
    await providerPool.enqueueAction(ctx, internal.payments.intake.refreshReleasedPayment, {
      connectionId, externalPaymentId,
    });
  }
}

export async function releasePaymentFence(ctx: MutationCtx, payment: Doc<"providerPayments">) {
  const newest = await pendingAdverseReceipts(ctx, payment.connectionId, payment.externalPaymentId)
    .order("desc").first();
  const adverseState = payment.sourceAdverseState ?? "none";
  await ctx.db.patch("providerPayments", payment._id, {
    adverseFencedAt: undefined,
    adverseState,
    refreshGeneration: payment.refreshGeneration + 1,
    ...adverseReviewUpdate(payment, {
      adverseState, adverseFencedAt: undefined, refundedMinor: payment.refundedMinor,
    }, Date.now(), false),
  });
  await resolveReleasedReceipts(ctx, payment, newest?._creationTime);
  await refreshProviderPaymentReview(ctx, payment._id);
}

export const continueAdverseRelease = internalMutation({
  args: { providerPaymentId: v.id("providerPayments"), through: v.number() },
  returns: v.null(),
  handler: async (ctx, { providerPaymentId, through }) => {
    const payment = await ctx.db.get("providerPayments", providerPaymentId);
    if (payment) await resolveReleasedReceipts(ctx, payment, through);
    return null;
  },
});

export const refreshReleasedPayment = internalAction({
  args: { connectionId, externalPaymentId: v.string() },
  returns: v.null(),
  handler: async (ctx, { connectionId, externalPaymentId }): Promise<null> => {
    const connection = await ctx.runQuery(internal.payments.connectionState.connection, { connectionId });
    if (connection?.status !== "connected") return null;
    try {
      const result = await refreshWhopPayment(ctx, connection, externalPaymentId);
      if (result !== "superseded") return null;
    } catch (error) {
      reportWhopRequestError("whop.hold.refresh_failed", error, { connectionId });
    }
    await ctx.runMutation(internal.payments.reconcile.recordUnreadablePayments, {
      connectionId, connectedAt: connection.connectedAt, ids: [externalPaymentId],
    });
    return null;
  },
});

const attemptOutcome = v.union(
  v.literal("processed"), v.literal("missing_object"), v.literal("account_mismatch"),
  v.literal("provider_read_failed"), v.literal("connection_unavailable"),
);

async function finishReceiptAttempt(
  ctx: MutationCtx,
  args: { receiptId: Id<"paymentWebhookReceipts">; attempt: number; outcome: typeof attemptOutcome.type; retryMs?: number },
) {
  const row = await ctx.db.get("paymentWebhookReceipts", args.receiptId);
  if (row?.status !== "received" || row.attempts + 1 !== args.attempt) return;
  const now = Date.now();
  const connection = await ctx.db.get("tenantPaymentConnections", row.connectionId);
  const outcome = args.outcome === "provider_read_failed" && connection?.status !== "connected"
    ? "connection_unavailable" : args.outcome;
  if (outcome === "provider_read_failed" && args.attempt < MAX_ATTEMPTS) {
    const delay = Math.min(MAX_RETRY_AFTER_MS, Math.max(args.retryMs ?? 0, 5_000 * 2 ** (args.attempt - 1)));
    await ctx.db.patch("paymentWebhookReceipts", row._id, {
      attempts: args.attempt,
      retryAt: now + delay,
      failureCode: "provider_read_failed",
    });
    await enqueueReceipt(ctx, row._id, args.attempt + 1, delay);
    return;
  }
  const status = outcome === "processed" ? "processed"
    : outcome === "provider_read_failed" || outcome === "connection_unavailable" ? "failed" : "ignored";
  await ctx.db.patch("paymentWebhookReceipts", row._id, {
    status,
    attempts: args.attempt,
    processedAt: now,
    retryAt: undefined,
    failureCode: outcome === "processed" ? undefined
      : outcome === "provider_read_failed" ? "attempts_exhausted" : outcome,
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
      if (connection.status !== "connected") {
        outcome = "connection_unavailable";
      } else {
        let externalPaymentId = receipt.externalPaymentId;
        let evidence: AdverseEvidence | undefined;
        const kind = adverseEvent(receipt.eventType);
        if (kind && receipt.adversePending && receipt.externalObjectId) {
          try {
            const object = await fetchAdverseResource(ctx, connection, kind, receipt.externalObjectId);
            if (object.paymentId && externalPaymentId && object.paymentId !== externalPaymentId)
              throw new WhopRequestError("unexpected_response");
            externalPaymentId = object.paymentId ?? externalPaymentId;
            if (externalPaymentId) {
              const fencedAt = await ctx.runMutation(internal.payments.intake.attachAdversePayment, {
                receiptId: receipt._id, externalPaymentId, connectedAt: connection.connectedAt,
              });
              if (fencedAt === null) throw new WhopRequestError("unexpected_response");
              evidence = {
                kind, receiptId: receipt._id, state: object.state,
                updatedAt: object.updatedAt, refundMinor: object.refundMinor,
              };
            }
          } catch (error) {
            if (!externalPaymentId ||
                !(error instanceof WhopRequestError) || error.code !== "forbidden") throw error;
            // Refresh canonical facts while the resource remains fenced.
          }
        }
        if (!externalPaymentId) {
          outcome = "missing_object";
        } else {
          const result = await refreshWhopPayment(ctx, connection, externalPaymentId, evidence && [evidence]);
          if (result !== "superseded") {
            if (!kind) {
              outcome = "processed";
            } else {
              const after = await ctx.runQuery(internal.payments.intake.receipt, { receiptId: receipt._id });
              if (after && !after.adversePending) outcome = "processed";
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof WhopAccountMismatch) {
        outcome = "account_mismatch";
      } else if (error instanceof WhopRequestError) {
        retryMs = error.retryAfterMs;
      }
      if (outcome !== "account_mismatch") {
        reportWhopRequestError("whop.webhook.read_failed", error, {
          connectionId: receipt.connectionId, receiptId: receipt._id,
        });
      }
    }
    await ctx.runMutation(internal.payments.intake.finishAttempt, { ...args, outcome, retryMs });
    return null;
  },
});
