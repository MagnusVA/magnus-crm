import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { noteHumanResult } from "../automation/humanResult";
import { modeAtLeastAsk, type PaymentProposal } from "../automation/proposals";
import { recordApplyReceipt, type PaymentDecisionKind } from "../automation/receipts";
import { effectiveKindMode } from "../automation/settings";
import { followMergeChain } from "../leads/identityResolution";
import { emitDomainEvent } from "../lib/domainEvents";
import { paymentCounts } from "../lib/enrollments";
import { mergedLeadIds } from "../lib/mergedLeads";
import { isPlaceholderEmail, normalizeEmail } from "../lib/normalization";
import { expectedError } from "../lib/observability/errors";
import { computeLatestActivityAt } from "../lib/opportunityActivity";
import type { CoreActor } from "../lib/outcomeCores";
import { checkPaymentProof, newPaymentFields } from "../lib/paymentProof";
import { paymentTypeValidator } from "../lib/paymentTypes";
import { isSideDeal } from "../lib/sideDeals";
import { isWonDeal } from "../opportunities/dealGuards";
import { dealPosition } from "../opportunities/stages";
import { requireTenantUser } from "../requireTenantUser";
import { readActiveAllocation, sandboxAllocationBlocked, sandboxPaymentError, setActiveAllocation } from "./allocation";
import { readEligibleProviderProposal, type ProviderConfirmSubject } from "./apply";
import { PAYMENT_ROWS_PER_DEAL_HOLD } from "./capacity";
import { findConnection } from "./connection";
import { adverseReviewRequired } from "./intake";
import { findPaymentTarget } from "./match";

export type ReconcileWriter = "meeting" | "reminder" | "side_deal" | "additional";
type ReadCtx = QueryCtx | MutationCtx;
type Payment = Doc<"providerPayments">;
type Deal = Doc<"opportunities">;

const pinValidator = v.object({
  providerPaymentId: v.id("providerPayments"),
  allocationRevision: v.number(),
});
type Pin = Infer<typeof pinValidator>;

const productTitleFields = {
  productTitle: v.optional(v.string()),
  variantTitle: v.optional(v.string()),
};
const paymentConflictValidator = v.object({
  ...productTitleFields,
  ...pinValidator.fields,
  state: v.union(v.literal("unlinked"), v.literal("recorded_here"), v.literal("recorded_elsewhere")),
  totalMinor: v.optional(v.number()),
  currency: v.string(),
  paidAt: v.optional(v.number()),
  recordedPaymentRecordId: v.optional(v.id("paymentRecords")),
});
const conflictValidator = v.union(
  paymentConflictValidator,
  v.object({
    state: v.literal("read_limit"),
    ...productTitleFields,
    // An identity range can overflow before a provider payment is known.
    providerPaymentId: v.optional(v.id("providerPayments")),
    allocationRevision: v.optional(v.number()),
    currency: v.optional(v.string()),
  }),
);
export type ReconcileConflict = Infer<typeof conflictValidator>;
type PaymentConflict = Infer<typeof paymentConflictValidator>;

const acknowledgedAmountsValidator = v.object({
  crmAmountMinor: v.number(),
  crmCurrency: v.string(),
  providerTotalMinor: v.number(),
  providerCurrency: v.string(),
});

export const providerIntentValidator = v.union(
  v.object({
    kind: v.literal("confirm"),
    providerPaymentId: v.id("providerPayments"),
    expectedAllocationRevision: v.number(),
    decisionId: v.optional(v.id("resultAutomationDecisions")),
    otherPins: v.optional(v.array(pinValidator)),
  }),
  v.object({
    kind: v.literal("same_money"),
    providerPaymentId: v.id("providerPayments"),
    expectedAllocationRevision: v.number(),
    acknowledgeAmountDifference: v.boolean(),
    acknowledgedAmounts: v.optional(acknowledgedAmountsValidator),
    otherPins: v.optional(v.array(pinValidator)),
  }),
  v.object({
    kind: v.literal("different_money"),
    pins: v.array(pinValidator),
    acknowledgeReadLimit: v.optional(v.boolean()),
  }),
);
export type ProviderIntent = Infer<typeof providerIntentValidator>;
export const WHOP_PAYMENT_FOUND = "payment.whop_payment_found";

const PAYMENT_READ_LIMIT = 20;
const MAX_DISTINCT_FROM = 10;

function paymentKind(writer: ReconcileWriter): PaymentDecisionKind {
  return writer === "additional" ? "additional_payment" : "payment_win";
}

export function readReconciliationDealPayments(ctx: ReadCtx, opportunityId: Id<"opportunities">) {
  return ctx.db.query("paymentRecords")
    .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", opportunityId))
    .take(PAYMENT_ROWS_PER_DEAL_HOLD + 1);
}

async function personEmails(
  ctx: ReadCtx,
  person: Doc<"leads">,
  leadIds: Id<"leads">[],
) {
  const emails = new Set<string>();
  const add = (email?: string) => {
    const normalized = email && normalizeEmail(email);
    if (normalized && !isPlaceholderEmail(normalized)) emails.add(normalized);
  };
  for (const leadId of leadIds) {
    const lead = leadId === person._id ? person : await ctx.db.get("leads", leadId);
    if (lead?.tenantId !== person.tenantId ||
        (leadId !== person._id && (await followMergeChain(ctx, lead))?._id !== person._id)) continue;
    add(lead.email);
    const identifiers = await ctx.db.query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", leadId)).take(PAYMENT_READ_LIMIT + 1);
    if (identifiers.length > PAYMENT_READ_LIMIT) return null;
    for (const identifier of identifiers) {
      if (identifier.tenantId === person.tenantId && identifier.type === "email" &&
          identifier.confidence !== "suggested") add(identifier.value);
    }
    if (emails.size > PAYMENT_READ_LIMIT) return null;
  }
  return emails;
}

async function matchesDeal(ctx: ReadCtx, payment: Payment, leadId: Id<"leads">, opportunityId: Id<"opportunities">) {
  if (payment.excludedOpportunityIds?.includes(opportunityId) || payment.notMySaleAt !== undefined ||
      payment.reviewReason === "covers_several" || payment.reviewReason === "amount_mismatch") return false;
  const target = await findPaymentTarget(ctx, payment);
  return target.kind === "ready" && target.leadId === leadId && target.opportunityId === opportunityId;
}

function readLimit(payment?: Payment): ReconcileConflict[] {
  return [{
    state: "read_limit",
    ...(payment && {
      providerPaymentId: payment._id,
      allocationRevision: payment.allocationRevision,
      currency: payment.currency,
      productTitle: payment.productTitle,
      variantTitle: payment.variantTitle,
    }),
  }];
}

/** Reads the same person ranges in the dialog query and the payment transaction. */
export async function checkPaymentReconciliation(ctx: ReadCtx, args: {
  tenantId: Id<"tenants">;
  leadId: Id<"leads">;
  opportunityId: Id<"opportunities">;
  writer: ReconcileWriter;
  dealPayments: Doc<"paymentRecords">[];
}): Promise<ReconcileConflict[]> {
  const { tenantId, leadId, opportunityId, writer, dealPayments } = args;
  const connections = (await Promise.all([
    findConnection(ctx, tenantId, "live"),
    findConnection(ctx, tenantId, "sandbox"),
  ])).filter((connection) => connection !== null).filter((connection) => !sandboxAllocationBlocked(connection));
  if (!connections.length) return [];
  const [tenant, person] = await Promise.all([
    ctx.db.get("tenants", tenantId),
    ctx.db.get("leads", leadId),
  ]);
  if (person?.tenantId !== tenantId || person.status === "merged") return [];
  const ask = tenant && modeAtLeastAsk(effectiveKindMode(tenant, paymentKind(writer)));
  const pausedAt = tenant?.resultAutomation?.pausedAt;
  const leadIds = await mergedLeadIds(ctx, tenantId, leadId);
  const connectedIds = new Set(connections.filter((connection) => connection.status === "connected")
    .map((connection) => connection._id));
  const emails = ask && connectedIds.size ? await personEmails(ctx, person, leadIds) : new Set<string>();
  if (!emails || leadIds.length >= PAYMENT_READ_LIMIT) return readLimit();
  const distinctFrom = new Set(dealPayments.filter(paymentCounts)
    .flatMap((record) => record.distinctFromProviderPaymentIds ?? []));
  const candidates = new Map<Id<"providerPayments">, Payment>();
  for (const { _id: connectionId } of connections) {
    // Allocating always sets leadId. The extra ranges only discover unlinked
    // facts, so their overflow can't hold a manual save while ask is off.
    const ranges = leadIds.map((id) =>
      ctx.db.query("providerPayments").withIndex("by_connectionId_and_leadId_and_paidAt", (q) =>
        q.eq("connectionId", connectionId).eq("leadId", id)));
    if (ask && connectedIds.has(connectionId)) {
      ranges.push(...leadIds.map((id) =>
        ctx.db.query("providerPayments").withIndex("by_connectionId_and_candidateLeadId_and_paidAt", (q) =>
          q.eq("connectionId", connectionId).eq("candidateLeadId", id))));
      ranges.push(...[...emails].map((email) =>
        ctx.db.query("providerPayments").withIndex("by_connectionId_and_payerEmail_and_paidAt", (q) =>
          q.eq("connectionId", connectionId).eq("payerEmail", email))));
    }
    for (const range of ranges) {
      const rows = await range.take(PAYMENT_READ_LIMIT + 1);
      if (rows.length > PAYMENT_READ_LIMIT) return readLimit(rows.find((row) => row.tenantId === tenantId));
      for (const row of rows) {
        if (row.tenantId === tenantId) candidates.set(row._id, row);
      }
      if (candidates.size > PAYMENT_READ_LIMIT) return readLimit(rows.find((row) => row.tenantId === tenantId));
    }
  }

  const conflicts: ReconcileConflict[] = [];
  for (const payment of candidates.values()) {
    if (distinctFrom.has(payment._id) || payment.reviewState === "linked") continue;
    let record: Doc<"paymentRecords"> | null = null;
    if (payment.paymentRecordId) {
      record = await readActiveAllocation(ctx, payment);
      if (record?.origin !== "provider" || !record.opportunityId) continue;
      const recordedDeal = await ctx.db.get("opportunities", record.opportunityId);
      if (recordedDeal?.tenantId !== tenantId || recordedDeal.leadId !== leadId) continue;
    } else {
      if (!ask || !connectedIds.has(payment.connectionId) || payment.status !== "paid" ||
          payment.reviewState !== "needs_person" ||
          (pausedAt !== undefined && (payment.paidAt === undefined || payment.paidAt <= pausedAt))) continue;
      if (!await matchesDeal(ctx, payment, leadId, opportunityId)) continue;
    }
    conflicts.push({
      providerPaymentId: payment._id,
      allocationRevision: payment.allocationRevision,
      state: record ? (record.opportunityId === opportunityId ? "recorded_here" : "recorded_elsewhere") : "unlinked",
      totalMinor: payment.totalMinor,
      currency: payment.currency,
      paidAt: payment.paidAt,
      productTitle: payment.productTitle,
      variantTitle: payment.variantTitle,
      recordedPaymentRecordId: record?._id,
    });
  }
  return conflicts;
}

/** How long after Whop collects a charge a second, hand-logged copy of it is plausible. */
export const RECENT_WHOP_MONEY_MS = 30 * 86_400_000;

/**
 * True when Whop collected money from this person since `since`, in any state:
 * waiting, recorded, or linked to a payment someone typed. A closer who is not
 * on the deal can't be shown that money, so a recent charge sends their manual
 * save to Billing. Older charges hold nothing: time narrows the hold, it never
 * ties the two payments together.
 */
export async function hasRecentWhopMoney(ctx: ReadCtx, args: {
  tenantId: Id<"tenants">; leadId: Id<"leads">; since: number;
}): Promise<boolean> {
  const { tenantId, leadId, since } = args;
  const connections = (await Promise.all([
    findConnection(ctx, tenantId, "live"), findConnection(ctx, tenantId, "sandbox"),
  ])).filter((connection) => connection !== null).filter((connection) => !sandboxAllocationBlocked(connection));
  if (!connections.length) return false;
  const leadIds = await mergedLeadIds(ctx, tenantId, leadId);
  if (leadIds.length >= PAYMENT_READ_LIMIT) return true;
  for (const { _id: connectionId } of connections) {
    for (const id of leadIds) {
      const rows = await ctx.db.query("providerPayments")
        .withIndex("by_connectionId_and_leadId_and_paidAt", (q) =>
          q.eq("connectionId", connectionId).eq("leadId", id).gte("paidAt", since))
        .take(PAYMENT_READ_LIMIT + 1);
      if (rows.length > PAYMENT_READ_LIMIT) return true;
      if (rows.some((row) => row.tenantId === tenantId && row.status === "paid" && row.totalMinor !== 0 &&
          row.reviewState !== "dismissed")) return true;
    }
  }
  return false;
}

function stalePreview() {
  return expectedError("payment.stale_preview", "The Whop confirmation changed. Reload before saving.");
}

function refuseConflict(conflicts: ReconcileConflict[]): never {
  throw new ConvexError({
    code: WHOP_PAYMENT_FOUND,
    message: conflicts.some((conflict) => conflict.state === "read_limit")
      ? "The CRM couldn't check all Whop payments for this person. Contact Billing."
      : "Review the Whop payment before saving.",
    conflicts,
  });
}

function pinsMatch(conflicts: PaymentConflict[], pins: Pin[]) {
  if (pins.length !== conflicts.length) return false;
  const revisions = new Map(pins.map((pin) => [pin.providerPaymentId, pin.allocationRevision]));
  return revisions.size === pins.length && conflicts.every((conflict) =>
    revisions.get(conflict.providerPaymentId) === conflict.allocationRevision);
}

type DistinctFrom = { distinctFrom: Id<"providerPayments">[] };
type InsertManual = { action: "insert" } & DistinctFrom;
type AttachExisting = { action: "attach_existing"; paymentRecordId: Id<"paymentRecords"> } & DistinctFrom;

export function resolveReconciliation(conflicts: ReconcileConflict[], intent?: ProviderIntent):
  | InsertManual
  | ({ action: "insert_and_link" | "insert_from_provider"; providerPaymentId: Id<"providerPayments"> } & DistinctFrom)
  | AttachExisting {
  if (!intent && !conflicts.length) return { action: "insert", distinctFrom: [] };
  const paymentConflicts = conflicts.filter((conflict) => conflict.state !== "read_limit");
  const hitReadLimit = paymentConflicts.length !== conflicts.length;
  if (!intent || !conflicts.length || paymentConflicts.length > MAX_DISTINCT_FROM) refuseConflict(conflicts);

  if (intent.kind === "different_money") {
    if ((hitReadLimit && intent.acknowledgeReadLimit !== true) || !pinsMatch(paymentConflicts, intent.pins)) {
      refuseConflict(conflicts);
    }
    return { action: "insert", distinctFrom: intent.pins.map((pin) => pin.providerPaymentId) };
  }

  if (hitReadLimit) refuseConflict(conflicts);
  const conflict = paymentConflicts.find((conflict) => conflict.providerPaymentId === intent.providerPaymentId);
  if (!conflict || conflict.allocationRevision !== intent.expectedAllocationRevision) refuseConflict(conflicts);
  const otherConflicts = paymentConflicts.filter((other) => other !== conflict);
  const otherPins = intent.otherPins ?? [];
  if (!pinsMatch(otherConflicts, otherPins)) refuseConflict(conflicts);
  const distinctFrom = otherPins.map((pin) => pin.providerPaymentId);
  if (conflict.state === "unlinked") {
    return {
      action: intent.kind === "confirm" ? "insert_from_provider" : "insert_and_link",
      providerPaymentId: conflict.providerPaymentId,
      distinctFrom,
    };
  }
  if (intent.kind === "same_money" && conflict.state === "recorded_here" && conflict.recordedPaymentRecordId) {
    return { action: "attach_existing", paymentRecordId: conflict.recordedPaymentRecordId, distinctFrom };
  }
  refuseConflict(conflicts);
}

type Reconciliation =
  | InsertManual
  | AttachExisting
  | ({
    action: "insert_and_link";
    payment: Payment;
    acknowledgeAmountDifference: boolean;
    acknowledgedAmounts?: Infer<typeof acknowledgedAmountsValidator>;
    conflicts: ReconcileConflict[];
  } & DistinctFrom)
  | ({
    action: "insert_from_provider";
    payment: Payment;
    proposal: PaymentProposal;
    decisionId?: Id<"resultAutomationDecisions">;
  } & DistinctFrom);

export async function reconcilePaymentWrite(
  ctx: ReadCtx,
  opportunity: Deal,
  writer: ReconcileWriter,
  dealPayments: Doc<"paymentRecords">[],
  intent?: ProviderIntent,
  subject?: ProviderConfirmSubject,
): Promise<Reconciliation> {
  const { tenantId, leadId, _id: opportunityId } = opportunity;
  let selected: Payment | null = null;
  if (intent && intent.kind !== "different_money") {
    selected = await ctx.db.get("providerPayments", intent.providerPaymentId);
    const connection = selected?.tenantId === tenantId &&
      await ctx.db.get("tenantPaymentConnections", selected.connectionId);
    if (connection && connection.tenantId === tenantId && sandboxAllocationBlocked(connection)) {
      throw sandboxPaymentError();
    }
  }
  const conflicts = await checkPaymentReconciliation(ctx, { tenantId, leadId, opportunityId, writer, dealPayments });
  const tenant = intent?.kind === "confirm" ? await ctx.db.get("tenants", tenantId) : null;
  if (intent?.kind === "confirm" && (!tenant || !modeAtLeastAsk(effectiveKindMode(tenant, paymentKind(writer))))) {
    throw expectedError("payment.kind_off", "Whop confirmation is turned off for this payment.");
  }
  const decision = intent?.kind === "confirm" && intent.decisionId
    ? await ctx.db.get("resultAutomationDecisions", intent.decisionId) : null;
  if (intent?.kind === "confirm" && selected?.tenantId === tenantId &&
      decision?.tenantId === tenantId && decision.opportunityId === opportunityId &&
      decision.providerPaymentId === selected._id && (adverseReviewRequired(selected) || selected.refundedMinor > 0)) {
    throw expectedError("payment.adverse", "Billing must review this Whop payment before it can be confirmed.");
  }
  if (selected?.tenantId === tenantId && !selected.paymentRecordId &&
      !conflicts.some((conflict) => conflict.state === "unlinked" && conflict.providerPaymentId === selected?._id) &&
      !conflicts.some((conflict) => conflict.state === "read_limit")) {
    throw stalePreview();
  }
  const result = resolveReconciliation(conflicts, intent);
  if (result.action === "insert") return result;
  if (result.action === "attach_existing") {
    if (!result.distinctFrom.length) return result;
    const record = await ctx.db.get("paymentRecords", result.paymentRecordId);
    if (record?.tenantId !== tenantId) throw new Error("Whop payment record missing");
    const previous = record.distinctFromProviderPaymentIds ?? [];
    const distinctFrom = [...new Set([...previous, ...result.distinctFrom])];
    if (distinctFrom.length > MAX_DISTINCT_FROM) refuseConflict(conflicts);
    return { ...result, distinctFrom };
  }

  const { distinctFrom, providerPaymentId } = result;
  const payment = selected;
  if (payment?.tenantId !== tenantId || payment._id !== providerPaymentId) {
    throw new Error("Whop payment not found after reconciliation");
  }
  if (intent?.kind === "confirm") {
    if (intent.decisionId && !decision) throw stalePreview();
    const proposal = await readEligibleProviderProposal(
      ctx, { tenantId, opportunityId, providerPaymentId, now: Date.now() }, decision ?? undefined, subject,
    );
    if (!proposal || paymentKind(writer) !== (isWonDeal(opportunity) ? "additional_payment" : "payment_win")) {
      throw stalePreview();
    }
    return { action: "insert_from_provider", payment, proposal, decisionId: intent.decisionId, distinctFrom };
  }
  if (intent?.kind !== "same_money") throw new Error("Missing Whop link intent");
  if (writer === "additional" && !await readEligibleProviderProposal(ctx, {
    tenantId, opportunityId, providerPaymentId, now: Date.now(),
  })) throw stalePreview();
  return {
    action: "insert_and_link", payment, distinctFrom, conflicts,
    acknowledgeAmountDifference: intent.acknowledgeAmountDifference, acknowledgedAmounts: intent.acknowledgedAmounts,
  };
}

export type InsertReconciliation = Exclude<Reconciliation, { action: "attach_existing" }>;

/** Accept the form only if it still agrees with the server's mapping. */
export function reconciledPaymentSelection(
  result: InsertReconciliation | undefined,
  submitted: Pick<PaymentProposal, "programId" | "paymentType">,
) {
  if (result?.action !== "insert_from_provider") return submitted;
  const { proposal } = result;
  if (proposal.programId !== submitted.programId || proposal.paymentType !== submitted.paymentType) throw stalePreview();
  return proposal;
}

/** Only an equal, selected Whop payment can waive proof on a new row. */
export function providerWaivesProof(result: InsertReconciliation, amountMinor: number, currency: string) {
  if (result.action === "insert") return false;
  const equal = result.payment.totalMinor === amountMinor && result.payment.currency === currency;
  if (result.action === "insert_from_provider") {
    if (!equal) throw expectedError("payment.amount_mismatch", "The amount or currency differs from the Whop payment.");
  } else {
    const { acknowledgedAmounts: seen } = result;
    const requiresConsent = !equal || result.acknowledgeAmountDifference || seen !== undefined;
    if (requiresConsent && (!result.acknowledgeAmountDifference || !seen ||
        seen.crmAmountMinor !== amountMinor || seen.crmCurrency !== currency ||
        seen.providerTotalMinor !== result.payment.totalMinor || seen.providerCurrency !== result.payment.currency)) {
      throw new ConvexError({
        code: "payment.amount_mismatch",
        message: "Confirm both amounts and currencies before linking the payments.",
        conflicts: result.conflicts,
      });
    }
  }
  return equal;
}

export function reconciledPaymentFields(result: InsertReconciliation) {
  const distinctFields = result.distinctFrom.length ? { distinctFromProviderPaymentIds: result.distinctFrom } : {};
  if (result.action === "insert_from_provider") {
    return {
      ...distinctFields,
      recordedVia: "provider" as const,
      providerPaymentId: result.payment._id,
      providerPaidAt: result.payment.paidAt,
    };
  }
  return distinctFields;
}

export async function allocateReconciledPayment(
  ctx: MutationCtx,
  result: InsertReconciliation,
  paymentId: Id<"paymentRecords">,
  actor: CoreActor,
  now: number,
) {
  if (result.action === "insert") return;
  const record = await ctx.db.get("paymentRecords", paymentId);
  if (!record) throw new Error("New payment record missing");
  await setActiveAllocation(ctx, {
    payment: result.payment,
    record,
    expectedAllocationRevision: result.payment.allocationRevision,
    reviewState: result.action === "insert_from_provider" ? "recorded" : "linked",
    matchMethod: "person",
    actorUserId: actor.userId,
    now,
  });
  if (result.action === "insert_and_link") {
    await emitDomainEvent(ctx, {
      tenantId: actor.tenantId,
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment.provider_linked",
      source: actor.role === "closer" ? "closer" : "admin",
      actorUserId: actor.userId,
      metadata: { providerPaymentId: result.payment._id, paymentRecordId: paymentId },
      occurredAt: now,
    });
  }
}

export async function attachReconciledPayment(
  ctx: MutationCtx,
  { paymentRecordId: paymentId, distinctFrom }: AttachExisting,
  actor: CoreActor,
  proofFileId?: Id<"_storage">,
) {
  const distinctFields = distinctFrom.length ? { distinctFromProviderPaymentIds: distinctFrom } : null;
  if (!proofFileId && !distinctFields) return false;
  const payment = await ctx.db.get("paymentRecords", paymentId);
  if (payment?.tenantId !== actor.tenantId) throw new Error("Whop payment record missing");
  if (!proofFileId || payment.proofFileId === proofFileId) {
    if (!distinctFields) return false;
    await ctx.db.patch("paymentRecords", paymentId, distinctFields);
    return true;
  }
  if (payment.proofFileId) {
    throw expectedError("payment.has_proof", "This payment already has proof. Billing can replace it.");
  }
  const proof = await checkPaymentProof(ctx, { role: actor.role, userId: actor.userId, proofFileId });
  const fields = await newPaymentFields(ctx, actor.tenantId, proof, { via: "web" });
  await ctx.db.patch("paymentRecords", paymentId, {
    ...distinctFields,
    proofFileId,
    proofSha256: fields.proofSha256,
    proofReused: fields.proofReused,
  });
  await emitDomainEvent(ctx, {
    tenantId: actor.tenantId,
    entityType: "payment",
    entityId: paymentId,
    eventType: "payment.proof_attached",
    source: actor.role === "closer" ? "closer" : "admin",
    actorUserId: actor.userId,
    metadata: { reused: Boolean(fields.proofReused) },
  });
  return true;
}

function receiptBefore(
  deal: Deal,
  meeting?: Doc<"meetings">,
  task?: Doc<"followUps">,
): Doc<"resultAutomationDecisions">["before"] {
  const position = dealPosition(deal.stage, deal.outcome);
  if (position !== "booked" && position !== "follow_up" && position !== "won") return undefined;
  return {
    position,
    latestActivityAt: deal.latestActivityAt ?? computeLatestActivityAt(deal),
    meetings: meeting ? [{ meetingId: meeting._id, status: meeting.status }] : [],
    tasks: task ? [{ followUpId: task._id, status: task.status }] : [],
  };
}

const RECEIPT_ROUTE = {
  meeting: "meeting_attended",
  reminder: "reminder",
  side_deal: "side_deal",
  additional: "billing",
} as const;

export async function finishReconciledPayment(
  ctx: MutationCtx,
  result: InsertReconciliation,
  args: {
    actor: CoreActor;
    writer: ReconcileWriter;
    opportunity: Deal;
    paymentId: Id<"paymentRecords">;
    now: number;
    meeting?: Doc<"meetings">;
    task?: Doc<"followUps">;
  },
) {
  const { actor, writer, opportunity, paymentId, now } = args;
  let consumeDecisionId: Id<"resultAutomationDecisions"> | undefined;
  if (result.action === "insert_from_provider") {
    consumeDecisionId = await recordApplyReceipt(ctx, {
      decisionId: result.decisionId,
      tenantId: actor.tenantId,
      kind: paymentKind(writer),
      providerPaymentId: result.payment._id,
      opportunityId: opportunity._id,
      paymentRecordId: paymentId,
      appliedVia: RECEIPT_ROUTE[writer],
      approverUserId: actor.userId,
      before: receiptBefore(opportunity, args.meeting, args.task),
      now,
    });
    await ctx.db.patch("paymentRecords", paymentId, { automationDecisionId: consumeDecisionId });
  }
  await noteHumanResult(ctx, opportunity._id, actor, { consumeDecisionId });
}

export async function loadMeetingPaymentTarget(
  ctx: ReadCtx,
  actor: CoreActor,
  target: { opportunityId: Id<"opportunities">; meetingId: Id<"meetings"> },
) {
  const opportunity = await ctx.db.get("opportunities", target.opportunityId);
  if (opportunity?.tenantId !== actor.tenantId) throw new Error("Opportunity not found");
  if (actor.role === "closer" && opportunity.assignedCloserId !== actor.userId) {
    throw new Error("Not your opportunity");
  }
  const meeting = await ctx.db.get("meetings", target.meetingId);
  if (meeting?.tenantId !== actor.tenantId || meeting.opportunityId !== opportunity._id) {
    throw new Error("Meeting does not belong to this opportunity");
  }
  return { opportunity, meeting };
}

export async function loadReminderPaymentTarget(
  ctx: ReadCtx,
  actor: CoreActor,
  followUpId: Id<"followUps">,
) {
  const followUp = await ctx.db.get("followUps", followUpId);
  if (!followUp) throw new Error("Reminder not found");
  if (followUp.tenantId !== actor.tenantId) throw new Error("Access denied");
  if (actor.role === "closer" && followUp.closerId !== actor.userId) throw new Error("Not your reminder");
  if (followUp.type !== "manual_reminder") throw new Error("Only manual reminders can be resolved on this page");
  if (followUp.reason === "stale_opportunity_nudge") {
    throw new Error("Stale opportunity nudges must be resolved from the opportunity detail page.");
  }
  const opportunity = await ctx.db.get("opportunities", followUp.opportunityId);
  if (opportunity?.tenantId !== actor.tenantId) throw new Error("Opportunity not found");
  return { opportunity, followUp };
}

const prefillValidator = v.object({
  providerPaymentId: v.id("providerPayments"),
  amount: v.optional(v.number()),
  currency: v.string(),
  programId: v.optional(v.id("tenantPrograms")),
  paymentType: v.optional(paymentTypeValidator),
});

export const getPaymentReconciliation = query({
  args: {
    target: v.union(
      v.object({ kind: v.literal("meeting"), meetingId: v.id("meetings") }),
      v.object({ kind: v.literal("reminder"), followUpId: v.id("followUps") }),
      v.object({ kind: v.literal("deal"), opportunityId: v.id("opportunities") }),
    ),
  },
  returns: v.object({ conflicts: v.array(conflictValidator), prefill: v.array(prefillValidator) }),
  handler: async (ctx, { target }) => {
    const actor = await requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"]);
    let opportunity: Deal;
    let writer: ReconcileWriter;
    if (target.kind === "meeting") {
      const meeting = await ctx.db.get("meetings", target.meetingId);
      if (meeting?.tenantId !== actor.tenantId) throw new Error("Meeting not found");
      ({ opportunity } = await loadMeetingPaymentTarget(ctx, actor, {
        meetingId: meeting._id,
        opportunityId: meeting.opportunityId,
      }));
      writer = "meeting";
    } else if (target.kind === "reminder") {
      ({ opportunity } = await loadReminderPaymentTarget(ctx, actor, target.followUpId));
      writer = "reminder";
    } else {
      const deal = await ctx.db.get("opportunities", target.opportunityId);
      if (deal?.tenantId !== actor.tenantId) throw new Error("Opportunity not found.");
      writer = isSideDeal(deal) && !isWonDeal(deal) ? "side_deal" : "additional";
      if (actor.role === "closer" && deal.assignedCloserId !== actor.userId) {
        throw new Error("You are not the assigned closer for this opportunity.");
      }
      opportunity = deal;
    }
    const dealPayments = await readReconciliationDealPayments(ctx, opportunity._id);
    const conflicts = await checkPaymentReconciliation(ctx, {
      tenantId: actor.tenantId,
      writer,
      opportunityId: opportunity._id,
      leadId: opportunity.leadId,
      dealPayments,
    });
    const unlinked = conflicts.filter((conflict): conflict is PaymentConflict => conflict.state === "unlinked");
    const prefill = unlinked.length === 1 ? await readPrefill(ctx, opportunity, unlinked[0].providerPaymentId) : [];
    return { conflicts, prefill };
  },
});

async function readPrefill(ctx: QueryCtx, deal: Deal, providerPaymentId: Id<"providerPayments">) {
  const proposal = await readEligibleProviderProposal(ctx, {
    tenantId: deal.tenantId, opportunityId: deal._id, providerPaymentId, now: Date.now(),
  });
  if (!proposal) return [];
  return [{
    providerPaymentId,
    amount: proposal.amountMinor / 100,
    currency: proposal.currency,
    programId: proposal.programId,
    paymentType: proposal.paymentType,
  }];
}
