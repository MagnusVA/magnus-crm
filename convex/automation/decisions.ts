import { makeFunctionReference } from "convex/server";
import { v, type Infer, type ObjectType } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { followMergeChain } from "../leads/identityResolution";
import { earliestCountingPayment, paymentCounts } from "../lib/enrollments";
import { addPinnedLine } from "../lib/pinnedLines";
import { isPlaceholderEmail, normalizeEmail } from "../lib/normalization";
import { resolveLegacyCompatibleAttributedCloserId } from "../lib/paymentTypes";
import { isSideDeal } from "../lib/sideDeals";
import { sha256Hex, stableJson } from "../lib/stableHash";
import { dealPosition, systemLossReasonOf } from "../opportunities/stages";
import { ALLOCATION_HISTORY_LIMIT } from "../payments/allocation";
import { DEALS_PER_PERSON_HOLD, PAYMENT_ROWS_PER_DEAL_HOLD } from "../payments/capacity";
import { FINGERPRINT_TASK_LIMIT } from "../payments/fingerprint";
import { findPaymentTarget } from "../payments/match";
import { mappingBlockReason, promotedCertificate } from "./breaker";
import { enrollInSample } from "./certificates";
import {
  deriveDecision, isAutomaticCallRefusal, PAYMENT_RULE_VERSION, paymentBillingReason, paymentDecisionTarget,
  type PaymentDecisionInput,
} from "./derive";
import { stopCallDecisionsOnPayment } from "./paymentHooks";
import { automationKindOf, modeAtLeastAsk, paymentEvidenceOf, type PaymentEvidence } from "./proposals";
import { APPLIED_RECEIPT_LIMIT, paymentVetoKey, type PaymentDecisionKind } from "./receipts";
import { stopCodeValidator } from "./schema";
import { effectiveAlertMode, effectiveKindMode } from "./settings";

const causeValidator = v.union(
  v.literal("provider_read"), v.literal("fence"), v.literal("mapping"), v.literal("binding"),
  v.literal("link"), v.literal("unlink"), v.literal("dismiss"), v.literal("reopen"), v.literal("acknowledge"),
  v.literal("release"), v.literal("human_result"), v.literal("assignment"), v.literal("booking"),
  v.literal("merge"), v.literal("settings"), v.literal("sweep"),
);
export type EvaluateCause = Infer<typeof causeValidator>;

type Decision = Doc<"resultAutomationDecisions">;
type Payment = Doc<"providerPayments">;
type Evidence = PaymentEvidence;
type StopCode = NonNullable<Decision["stopCode"]>;
type Gate = Decision["gates"][number];

const outstandingState = v.union(v.literal("ready"), v.literal("needs_person"), v.literal("blocked"), v.literal("shadow"));
const outstandingStates = ["ready", "needs_person", "blocked", "shadow"] as const;
const retirementBatch = 50;
const vetoHistoryLimit = 100;
const decisionResult = v.object({ decisionId: v.union(v.id("resultAutomationDecisions"), v.null()) });

const retireArgs = {
  tenantId: v.id("tenants"),
  providerPaymentId: v.id("providerPayments"),
  state: outstandingState,
  through: v.optional(v.number()),
  code: stopCodeValidator,
  superseded: v.boolean(),
  otherThan: v.optional(v.id("resultAutomationDecisions")),
  stoppedKind: v.optional(v.union(v.literal("payment_win"), v.literal("additional_payment"))),
};
type RetireArgs = ObjectType<typeof retireArgs>;
const continueRetirementRef = makeFunctionReference<"mutation", RetireArgs>("automation/decisions:continueRetirement");

async function retirePage(ctx: MutationCtx, args: RetireArgs) {
  const range = ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_providerPaymentId_and_state", (q) => {
      const subject = q.eq("tenantId", args.tenantId).eq("providerPaymentId", args.providerPaymentId).eq("state", args.state);
      return args.through === undefined ? subject : subject.lte("_creationTime", args.through);
    });
  const rows = await range.take(retirementBatch + 1);
  for (const row of rows.slice(0, retirementBatch)) {
    if (row._id === args.otherThan) continue;
    const reclassified = args.stoppedKind !== undefined && args.stoppedKind !== row.kind;
    const superseded = args.superseded || reclassified;
    await ctx.db.patch("resultAutomationDecisions", row._id, {
      state: superseded ? "superseded" : "stopped",
      resolvedAt: Date.now(),
      stopCode: reclassified ? "input_changed" : args.code,
      supersededByDecisionId: superseded ? args.otherThan : undefined,
    });
  }
  if (rows.length > retirementBatch) {
    const through = args.through ?? (await range.order("desc").first())?._creationTime;
    await ctx.scheduler.runAfter(0, continueRetirementRef, { ...args, through });
  }
}

export const continueRetirement = internalMutation({
  args: retireArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await retirePage(ctx, args);
    return null;
  },
});

async function retirePaymentDecisions(ctx: MutationCtx, args: Omit<RetireArgs, "state">) {
  for (const state of outstandingStates) await retirePage(ctx, { ...args, state });
}

/** Remove every outstanding proposal for a payment settled elsewhere. */
export async function supersedePaymentDecisions(
  ctx: MutationCtx,
  payment: Pick<Payment, "_id" | "tenantId">,
  otherThan?: Id<"resultAutomationDecisions">,
  through?: number,
): Promise<void> {
  await retirePaymentDecisions(ctx, {
    tenantId: payment.tenantId, providerPaymentId: payment._id,
    through, code: "input_changed", superseded: true, otherThan,
  });
}

export async function stopDecision(
  ctx: MutationCtx,
  decisionId: Id<"resultAutomationDecisions">,
  actor: { userId: Id<"users"> } | null,
  code: StopCode,
): Promise<void> {
  const decision = await ctx.db.get("resultAutomationDecisions", decisionId);
  if (!decision) return;
  if (actor && (await ctx.db.get("users", actor.userId))?.tenantId !== decision.tenantId) return;
  const superseded = code === "input_changed" || code === "merged";
  if (decision.state === "ready" || decision.state === "needs_person" ||
      decision.state === "blocked" || decision.state === "shadow" || decision.state === "notice") {
    const now = Date.now();
    await ctx.db.patch("resultAutomationDecisions", decisionId, {
      state: superseded ? "superseded" : "stopped",
      stopCode: code,
      resolvedAt: now,
      resolvedByUserId: actor?.userId,
    });
    if (decision.state === "notice" && decision.noticeUserId && decision.opportunityId &&
        (code === "paused" || code === "kind_lowered" || code === "breaker" || code === "certificate_lapsed")) {
      await addPinnedLine(ctx, {
        tenantId: decision.tenantId, userId: decision.noticeUserId, kind: "refusal_notice_withdrawn",
        opportunityId: decision.opportunityId, meetingId: decision.meetingId, decisionId, createdAt: now,
      });
    }
  } else if (decision.state !== "applied" && decision.state !== "superseded") {
    return;
  }
  if (decision.providerPaymentId && (superseded || decision.state === "applied")) {
    await supersedePaymentDecisions(ctx, {
      tenantId: decision.tenantId, _id: decision.providerPaymentId,
    }, decisionId);
  }
}

async function bindingFacts(ctx: MutationCtx, payment: Payment) {
  const keys = [
    ["product_program", payment.productId],
    ["variant_type", payment.variantId],
    ["membership_deal", payment.membershipId],
    ["checkout_deal", payment.checkoutConfigurationId],
  ] as const;
  const bindings = await Promise.all(keys.map(async ([kind, key]) => {
    if (!key) return null;
    // Match findEnabledBinding's two-version check, keeping the row id and
    // version as well as the value so decisions can pin and compare mappings.
    const [current, previous] = await ctx.db.query("paymentProviderBindings")
      .withIndex("by_tenantId_and_connectionId_and_kind_and_externalId", (q) =>
        q.eq("tenantId", payment.tenantId).eq("connectionId", payment.connectionId)
          .eq("kind", kind).eq("externalId", key))
      .order("desc").take(2);
    if ((current && current.binding.kind !== kind) || previous?.enabled) return "ambiguous" as const;
    return current ?? null;
  }));
  const [productRow, variantRow, membershipRow] = bindings;
  const product = productRow && productRow !== "ambiguous" && productRow.enabled && productRow.binding;
  const variant = variantRow && variantRow !== "ambiguous" && variantRow.enabled && variantRow.binding;
  const membership = membershipRow && membershipRow !== "ambiguous" && membershipRow.binding;
  const evidenceBindings = bindings.flatMap((row) => row && row !== "ambiguous" ? [row] : []);
  return {
    bindingConflict: bindings.includes("ambiguous"),
    product: product && product.kind === "product_program" ? product : undefined,
    variant: variant && variant.kind === "variant_type" ? variant : undefined,
    membership: membership && membership.kind === "membership_deal"
      ? { row: membershipRow, binding: membership } : null,
    bindingIds: evidenceBindings.map((row) => row._id),
    bindingVersions: evidenceBindings.map((row) => row.version),
  };
}

async function loadMembership(
  ctx: MutationCtx,
  payment: Payment,
  deal: Doc<"opportunities">,
  binding: Awaited<ReturnType<typeof bindingFacts>>["membership"],
) {
  if (!binding || binding.binding.opportunityId !== deal._id) return null;
  const [anchor, boundLead] = await Promise.all([
    ctx.db.get("paymentRecords", binding.binding.anchorPaymentRecordId),
    ctx.db.get("leads", binding.binding.leadId),
  ]);
  const origin = anchor?.providerPaymentId && await ctx.db.get("providerPayments", anchor.providerPaymentId);
  const survivor = boundLead?.tenantId === payment.tenantId ? await followMergeChain(ctx, boundLead) : null;
  const anchorCounts = binding.row.enabled && survivor?._id === deal.leadId &&
    anchor?.tenantId === payment.tenantId && anchor.opportunityId === deal._id && paymentCounts(anchor) &&
    !!origin && origin.tenantId === payment.tenantId && origin.connectionId === payment.connectionId &&
    origin.membershipId === payment.membershipId && origin.paymentRecordId === anchor._id;
  return {
    bindingId: binding.row._id, version: binding.row.version, anchorCounts,
    programId: anchorCounts ? anchor?.programId : undefined,
    anchorId: anchorCounts ? anchor?._id : undefined,
  };
}

// Same methods the matcher holds. Record this separately because the matcher
// can report an earlier gate and the decision keeps all known gates.
const financingMethods = new Set([
  "addi", "affirm", "afterpay", "afterpay_clearpay", "alma", "billie",
  "capchase_pay", "card_installments_three", "card_installments_six",
  "card_installments_twelve", "claritypay", "clearpay", "flex_pay",
  "klarna", "kriya", "kueski", "mondu", "oney", "oney_3x", "oney_4x",
  "paypal_pay_later", "scalapay", "sequra", "sezzle", "splitit", "sunbit",
  "tabby", "tamara", "zip",
]);

async function loadDealFacts(ctx: MutationCtx, deal: Doc<"opportunities">, payment: Payment, anchorId?: Id<"paymentRecords">) {
  const [payments, personDeals, tasks, meeting, provenance, closer] = await Promise.all([
    ctx.db.query("paymentRecords").withIndex("by_opportunityId_and_recordedAt", (q) =>
      q.eq("opportunityId", deal._id)).take(PAYMENT_ROWS_PER_DEAL_HOLD),
    ctx.db.query("opportunities").withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", deal.tenantId).eq("leadId", deal.leadId)).take(DEALS_PER_PERSON_HOLD),
    ctx.db.query("followUps").withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", deal._id).eq("status", "pending")).take(FINGERPRINT_TASK_LIMIT + 1),
    deal.stage === "booked" && ctx.db.query("meetings").withIndex("by_opportunityId_and_status_and_scheduledAt", (q) =>
      q.eq("opportunityId", deal._id).eq("status", "scheduled")).first(),
    ctx.db.query("paymentRecords").withIndex("by_tenantId_and_providerPaymentId", (q) =>
      q.eq("tenantId", deal.tenantId).eq("providerPaymentId", payment._id)).take(ALLOCATION_HISTORY_LIMIT + 1),
    deal.assignedCloserId && ctx.db.get("users", deal.assignedCloserId),
  ]);
  const gates: Gate[] = [];
  if (tasks.length > FINGERPRINT_TASK_LIMIT || provenance.length > ALLOCATION_HISTORY_LIMIT ||
      tasks.some((row) => row.tenantId !== deal.tenantId || row.leadId !== deal.leadId) ||
      payments.some((row) => row.tenantId !== deal.tenantId) ||
      (meeting && meeting.tenantId !== deal.tenantId)) {
    gates.push("read_limit");
  }
  if (provenance.some(paymentCounts)) gates.push("binding_conflict");
  const firstPayment = earliestCountingPayment(payments);
  const dealFacts: NonNullable<PaymentDecisionInput["deal"]> = {
    _id: deal._id,
    position: dealPosition(deal.stage, deal.outcome),
    isSideDeal: isSideDeal(deal),
    systemLoss: systemLossReasonOf(deal),
    callRefusal: isAutomaticCallRefusal(deal),
    createdAt: deal.createdAt,
    assignedCloserId: closer?.tenantId === deal.tenantId ? deal.assignedCloserId : undefined,
    humanResultRevision: deal.humanResultRevision ?? 0,
    storedPaymentCount: payments.length,
    personDealCount: personDeals.length,
    firstCountingCreditCloserId: firstPayment && resolveLegacyCompatibleAttributedCloserId(firstPayment),
    blockingManualPaymentIds: payments.flatMap((row) =>
      row.tenantId === deal.tenantId && row._id !== anchorId && row.providerPaymentId === undefined &&
      paymentCounts(row) ? [row._id] : []),
    currentMeeting: meeting && meeting.tenantId === deal.tenantId
      ? { _id: meeting._id, scheduledAt: meeting.scheduledAt } : undefined,
    pendingTasks: tasks.slice(0, FINGERPRINT_TASK_LIMIT).flatMap((row) =>
      row.tenantId === deal.tenantId && row.leadId === deal.leadId
        ? [{ _id: row._id, type: row.type, reason: row.reason, closerId: row.closerId }] : []),
  };
  return { deal: dealFacts, gates };
}

function humanInputsChanged(old: Evidence, current: Evidence) {
  return old.allocationRevision !== current.allocationRevision ||
    stableJson(old.bindingIds) !== stableJson(current.bindingIds) ||
    stableJson(old.bindingVersions) !== stableJson(current.bindingVersions);
}

async function vetoHistory(
  ctx: MutationCtx, tenantId: Id<"tenants">, vetoKey: string, evidence: Evidence,
  settings: NonNullable<Doc<"tenants">["resultAutomation"]>,
) {
  const rows = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_vetoKey", (q) => q.eq("tenantId", tenantId).eq("vetoKey", vetoKey))
    .order("desc").take(vetoHistoryLimit + 1);
  return {
    overflow: rows.length > vetoHistoryLimit,
    standDown: rows.some((row) => {
      if (row.state === "stopped" || (row.state === "superseded" && row.resolvedByUserId)) {
        const old = paymentEvidenceOf(row);
        return (row.stopCode !== "input_changed" && row.stopCode !== "merged") ||
          !old || !humanInputsChanged(old, evidence);
      }
      // The control's bounded retirement job may still be draining.
      if (row.state !== "ready" && row.state !== "needs_person" && row.state !== "blocked" && row.state !== "shadow") return false;
      const kind = automationKindOf(row.kind);
      const policy = kind ? settings.kinds[kind] : undefined;
      return (settings.pausedAt !== undefined && row.activationVersion < settings.activationVersion) ||
        (policy !== undefined && row.policyVersion < policy.policyVersion &&
          (policy.mode === "off" || (policy.mode === "shadow" && modeAtLeastAsk(row.mode))));
    }),
  };
}

/** Evaluate a provider fact in the same transaction as the input-key read and insert. */
function callPaymentStopsWanted(tenant: Doc<"tenants">) {
  return effectiveKindMode(tenant, "refusal_loss") !== "off" || effectiveAlertMode(tenant) !== "off";
}

async function stopFromWhop(
  ctx: MutationCtx, tenant: Doc<"tenants">, payment: Payment, leadId?: Id<"leads">,
) {
  if (payment.status !== "paid" || payment.totalMinor === 0 || payment.reviewState === "historical" ||
      payment.reviewState === "dismissed" || !leadId || !callPaymentStopsWanted(tenant)) return;
  await stopCallDecisionsOnPayment(ctx, {
    tenantId: tenant._id, leadId, opportunityId: payment.opportunityId ?? payment.candidateOpportunityId,
    paidAt: payment.paidAt, refusalOnly: payment.paidAt === undefined,
  });
}

type Settings = NonNullable<Doc<"tenants">["resultAutomation"]>;

/** What a payment derives to now, read in the caller's mutation. Reads only. */
type PaymentSubject =
  | { status: "disconnected" }
  | { status: "no_deal"; matchedLeadId?: Id<"leads"> }
  | { status: "kind_off"; matchedLeadId?: Id<"leads">; kind: PaymentDecisionKind }
  | { status: "underived"; matchedLeadId?: Id<"leads"> }
  | {
    status: "derived";
    matchedLeadId?: Id<"leads">;
    deal: Doc<"opportunities">;
    dealFacts: NonNullable<PaymentDecisionInput["deal"]>;
    mode: "shadow" | "ask" | "automatic";
    derived: NonNullable<ReturnType<typeof deriveDecision>>;
    evidence: Evidence;
    vetoKey: string;
    policyVersion: number;
    automaticGate: "out_of_scope" | "mapping_held" | null;
    automatic: boolean;
    inputKey: string;
  };

async function derivePaymentSubject(
  ctx: MutationCtx, tenant: Doc<"tenants">, settings: Settings, payment: Payment, now: number,
): Promise<PaymentSubject> {
  const tenantId = tenant._id;
  const connection = await ctx.db.get("tenantPaymentConnections", payment.connectionId);
  if (connection?.tenantId !== tenantId || connection.status === "disconnected") return { status: "disconnected" };
  const target = await findPaymentTarget(ctx, payment, now);
  const matchedLeadId = target.kind === "needs_person" ? target.candidateLeadId : target.leadId;
  const candidate = paymentDecisionTarget(target);
  const deal = candidate && await ctx.db.get("opportunities", candidate.opportunityId);
  if (!candidate?.leadId || deal?.tenantId !== tenantId || deal.leadId !== candidate.leadId ||
      payment.status !== "paid" || payment.totalMinor === 0) {
    return { status: "no_deal", matchedLeadId };
  }
  const kind = deal.outcome === "won" ? "additional_payment" : "payment_win";
  const mode = effectiveKindMode(tenant, kind);
  if (mode === "off") return { status: "kind_off", matchedLeadId, kind };

  const bindings = await bindingFacts(ctx, payment);
  const membership = await loadMembership(ctx, payment, deal, bindings.membership);
  const { deal: dealFacts, gates } = await loadDealFacts(ctx, deal, payment, membership?.anchorId);
  const renewal = paymentBillingReason(payment.billingReason) === "renewal";
  const programId = renewal && membership?.anchorCounts ? deal.soldProgramId ?? membership.programId : bindings.product?.programId;
  const program = programId && await ctx.db.get("tenantPrograms", programId);
  if (bindings.bindingConflict) gates.push("binding_conflict");
  if (membership?.anchorCounts && membership.programId !== programId) gates.push("program_mismatch");
  if (connection.status !== "connected") gates.push("connection_mismatch");
  if (payment.reviewReason === "covers_several" || payment.reviewReason === "amount_mismatch") {
    gates.push(payment.reviewReason);
  }

  const evidence = {
    allocationRevision: payment.allocationRevision,
    sourceUpdatedAt: payment.sourceUpdatedAt,
    bindingIds: bindings.bindingIds,
    bindingVersions: bindings.bindingVersions,
  };
  const vetoKey = await paymentVetoKey(payment._id, deal._id);
  const veto = await vetoHistory(ctx, tenantId, vetoKey, evidence, settings);
  if (veto.overflow) gates.push("read_limit");
  const policyVersion = settings.kinds[kind].policyVersion;
  // A payment collected before a pause stays with Billing even if its first
  // wake-up happened after resume and there is no old decision to retire.
  const paidBeforePause = settings.pausedAt !== undefined && payment.paidAt !== undefined &&
    payment.paidAt <= settings.pausedAt;
  const derived = deriveDecision({
    now, settings: { mode, policyVersion, activationVersion: settings.activationVersion },
    payment: {
      ...payment,
      fenced: payment.adverseFencedAt !== undefined,
      fenceRevision: payment.adverseFenceRevision,
      financing: (payment.financingInstallmentsCount ?? 0) > 1 || financingMethods.has(payment.paymentMethodType ?? ""),
      excludedOpportunityIds: payment.excludedOpportunityIds ?? [],
    },
    autoImportAfter: connection.autoImportAfter, connectionEpoch: connection.connectedAt,
    target, deal: dealFacts,
    mapping: {
      programId: program && program.tenantId === tenantId ? program._id : undefined,
      paymentType: kind === "additional_payment" ? bindings.variant?.laterPaymentType ?? bindings.variant?.paymentType : bindings.variant?.paymentType,
      bindingIds: evidence.bindingIds,
      bindingVersions: evidence.bindingVersions,
    },
    membership, standDown: veto.standDown || paidBeforePause, factGates: gates,
  });
  if (!derived) return { status: "underived", matchedLeadId };

  const sample = mode === "automatic" && derived.wouldWrite ? await promotedCertificate(ctx, tenant, kind) : null;
  const automaticGate = sample ? await mappingBlockReason(ctx, payment, evidence, sample.scopeBindingIds ?? []) : null;
  // An ask for a held/out-of-scope mapping and an automatic proposal have distinct keys.
  const inputKey = await sha256Hex(stableJson(automaticGate ? [...derived.inputTuple, automaticGate] : derived.inputTuple));
  return {
    status: "derived", matchedLeadId, deal, dealFacts, mode, derived, evidence, vetoKey, policyVersion,
    automaticGate, automatic: Boolean(sample) && !automaticGate, inputKey,
  };
}

/**
 * Re-derives a payment decision in the caller's mutation, the way
 * evaluateSubject would insert it now. `same` is true only when the
 * fingerprint equals the stored `inputKey` for the same deal.
 */
export async function rederivePayment(
  ctx: MutationCtx, decision: Decision, now: number,
): Promise<{ same: boolean }> {
  const [payment, tenant] = await Promise.all([
    decision.providerPaymentId ? ctx.db.get("providerPayments", decision.providerPaymentId) : null,
    ctx.db.get("tenants", decision.tenantId),
  ]);
  const settings = tenant?.resultAutomation;
  if (!payment || payment.tenantId !== decision.tenantId || !tenant || tenant.status !== "active" ||
      !settings?.enabled || payment.paymentRecordId) return { same: false };
  const subject = await derivePaymentSubject(ctx, tenant, settings, payment, now);
  return {
    same: subject.status === "derived" && subject.inputKey === decision.inputKey &&
      subject.deal._id === decision.opportunityId && subject.derived.kind === decision.kind,
  };
}

/** A first win waits this long after its decision becomes ready (plan §2.4). */
export const AUTOMATIC_WIN_GRACE_MS = 15 * 60_000;
const executeAutomaticPaymentRef = makeFunctionReference<"mutation", { decisionId: Id<"resultAutomationDecisions"> }>(
  "automation/automaticPayments:executeAutomaticPayment",
);

export async function evaluateSubject(ctx: MutationCtx, args: {
  tenantId: Id<"tenants">; providerPaymentId: Id<"providerPayments">; cause: EvaluateCause; now: number;
}): Promise<{ decisionId: Id<"resultAutomationDecisions"> | null }> {
  const { tenantId, providerPaymentId, now } = args;
  const [payment, tenant] = await Promise.all([
    ctx.db.get("providerPayments", providerPaymentId), ctx.db.get("tenants", tenantId),
  ]);
  if (payment?.tenantId !== tenantId || !tenant) return { decisionId: null };
  const settings = tenant.resultAutomation;
  const knownLeadId = payment.leadId ?? payment.candidateLeadId;
  await stopFromWhop(ctx, tenant, payment, knownLeadId);
  if (payment.paymentRecordId) {
    const receipts = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_providerPaymentId_and_state", (q) =>
        q.eq("tenantId", tenantId).eq("providerPaymentId", providerPaymentId).eq("state", "applied"))
      .take(APPLIED_RECEIPT_LIMIT + 1);
    const receipt = receipts.length <= APPLIED_RECEIPT_LIMIT
      ? receipts.find((row) => row.appliedPaymentRecordId === payment.paymentRecordId) : undefined;
    await supersedePaymentDecisions(ctx, payment, receipt?._id);
    return { decisionId: receipt?._id ?? null };
  }
  if (!settings?.enabled || tenant.status !== "active") {
    await retirePaymentDecisions(ctx, { tenantId, providerPaymentId, code: "paused", superseded: false });
    return { decisionId: null };
  }
  if (settings.kinds.payment_win.mode === "off" && settings.kinds.additional_payment.mode === "off") {
    await retirePaymentDecisions(ctx, { tenantId, providerPaymentId, code: "kind_lowered", superseded: false });
    return { decisionId: null };
  }

  const subject = await derivePaymentSubject(ctx, tenant, settings, payment, now);
  if (subject.status !== "disconnected" && subject.matchedLeadId !== knownLeadId) {
    await stopFromWhop(ctx, tenant, payment, subject.matchedLeadId);
  }
  if (subject.status === "disconnected" || subject.status === "no_deal") {
    await supersedePaymentDecisions(ctx, payment);
    return { decisionId: null };
  }
  if (subject.status === "kind_off") {
    await retirePaymentDecisions(ctx, {
      tenantId, providerPaymentId, code: "kind_lowered", superseded: false, stoppedKind: subject.kind,
    });
    return { decisionId: null };
  }
  if (subject.status === "underived") return { decisionId: null };

  const { deal, dealFacts, mode, derived, evidence, vetoKey, policyVersion, automaticGate, automatic, inputKey } = subject;
  const kind = derived.kind;
  const previous = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_inputKey", (q) => q.eq("tenantId", tenantId).eq("inputKey", inputKey))
    .unique();
  if (previous) return { decisionId: previous._id };

  const decisionMode = mode === "shadow" ? "shadow" : automatic ? "automatic" : "ask";
  const dueAt = automatic ? now + (kind === "payment_win" ? AUTOMATIC_WIN_GRACE_MS : 0) : undefined;
  const decisionId = await ctx.db.insert("resultAutomationDecisions", {
    tenantId, providerPaymentId, opportunityId: deal._id, leadId: deal.leadId,
    kind, mode: decisionMode, state: mode === "shadow" ? "shadow" : derived.wouldWrite ? "ready" : "needs_person",
    inputKey, vetoKey, ruleVersion: PAYMENT_RULE_VERSION,
    policyVersion, activationVersion: settings.activationVersion, humanResultRevision: dealFacts.humanResultRevision,
    wouldWrite: derived.wouldWrite && !automaticGate,
    gates: automaticGate ? [...derived.gates, automaticGate] : derived.gates, proposal: derived.proposal,
    confirmRoute: derived.confirmRoute, noticeUserId: derived.noticeUserId, assignedCloserId: dealFacts.assignedCloserId,
    meetingId: derived.meetingId, evidence, createdAt: now, dueAt,
  });
  const inserted = await ctx.db.get("resultAutomationDecisions", decisionId);
  if (inserted) await enrollInSample(ctx, inserted);
  await supersedePaymentDecisions(ctx, payment, decisionId);
  // The wake-up is not authority: the executor re-checks everything in its own mutation.
  if (dueAt !== undefined) await ctx.scheduler.runAt(dueAt, executeAutomaticPaymentRef, { decisionId });
  return { decisionId };
}

const evaluateArgs = {
  providerPaymentId: v.id("providerPayments"),
  cause: causeValidator,
  activationVersion: v.optional(v.number()),
};
const evaluateRef = makeFunctionReference<"mutation", ObjectType<typeof evaluateArgs>>("automation/decisions:evaluateProviderPayment");

export const evaluateProviderPayment = internalMutation({
  args: evaluateArgs,
  returns: decisionResult,
  handler: async (ctx, { providerPaymentId, cause, activationVersion }) => {
    const payment = await ctx.db.get("providerPayments", providerPaymentId);
    if (!payment) return { decisionId: null };
    if (activationVersion !== undefined) {
      const settings = (await ctx.db.get("tenants", payment.tenantId))?.resultAutomation;
      if (settings?.activationVersion !== activationVersion && settings?.enabled) return { decisionId: null };
    }
    return await evaluateSubject(ctx, { tenantId: payment.tenantId, providerPaymentId, cause, now: Date.now() });
  },
});

export async function scheduleEvaluation(
  ctx: MutationCtx, providerPaymentId: Id<"providerPayments">, cause: EvaluateCause,
): Promise<void> {
  const payment = await ctx.db.get("providerPayments", providerPaymentId);
  if (!payment) return;
  if (payment.paymentRecordId) {
    await supersedePaymentDecisions(ctx, payment);
    return;
  }
  const tenant = await ctx.db.get("tenants", payment.tenantId);
  const settings = tenant?.resultAutomation;
  if (!settings?.enabled) return;
  if (settings.kinds.payment_win.mode === "off" && settings.kinds.additional_payment.mode === "off") {
    if (tenant) await stopFromWhop(ctx, tenant, payment, payment.leadId ?? payment.candidateLeadId);
    return;
  }
  await ctx.scheduler.runAfter(0, evaluateRef, { providerPaymentId, cause, activationVersion: settings.activationVersion });
}

const leadPageArgs = {
  tenantId: v.id("tenants"),
  leadId: v.id("leads"),
  cause: causeValidator,
  lookup: v.union(v.literal("resolved"), v.literal("candidate"), v.literal("email")),
  identifierId: v.optional(v.id("leadIdentifiers")),
  emailKey: v.optional(v.string()),
  cursor: v.union(v.string(), v.null()),
  activationVersion: v.number(),
};
type LeadPageArgs = ObjectType<typeof leadPageArgs>;
const leadPageRef = makeFunctionReference<"mutation", LeadPageArgs>("automation/decisions:evaluateLeadPage");

export const evaluateLeadPage = internalMutation({
  args: leadPageArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const { tenantId, leadId, lookup, identifierId, activationVersion, cause } = args;
    const settings = (await ctx.db.get("tenants", tenantId))?.resultAutomation;
    if (!settings?.enabled || settings.activationVersion !== activationVersion) return null;
    let email: string | undefined;
    let emailKey: string | undefined;
    if (lookup === "email") {
      if (identifierId) {
        const alias = await ctx.db.get("leadIdentifiers", identifierId);
        if (alias?.tenantId !== tenantId || alias.leadId !== leadId ||
            alias.type !== "email" || alias.confidence === "suggested") return null;
        email = alias.value;
      } else {
        const lead = await ctx.db.get("leads", leadId);
        if (lead?.tenantId !== tenantId) return null;
        email = lead.email;
      }
      email = email && normalizeEmail(email);
      if (!email || isPlaceholderEmail(email)) return null;
      emailKey = await sha256Hex(email);
    }
    const cursor = args.emailKey === emailKey ? args.cursor : null;
    const payments = ctx.db.query("providerPayments");
    const range = lookup === "resolved"
      ? payments.withIndex("by_tenantId_and_leadId_and_paidAt", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
      : lookup === "candidate"
        ? payments.withIndex("by_tenantId_and_candidateLeadId_and_paidAt", (q) => q.eq("tenantId", tenantId).eq("candidateLeadId", leadId))
        : payments.withIndex("by_tenantId_and_payerEmail_and_paidAt", (q) => q.eq("tenantId", tenantId).eq("payerEmail", email));
    const page = await range.paginate({ cursor, numItems: 20, maximumBytesRead: 256 * 1024 });
    for (const payment of page.page) {
      if (payment.paymentRecordId) await supersedePaymentDecisions(ctx, payment);
      else if (payment.status === "paid" && payment.totalMinor !== 0) {
        await ctx.scheduler.runAfter(0, evaluateRef, { providerPaymentId: payment._id, cause, activationVersion });
      }
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, leadPageRef, { ...args, cursor: page.continueCursor, emailKey });
    return null;
  },
});

type HumanPaymentResult = {
  opportunityId: Id<"opportunities">;
  previousRevision: number;
  actorUserId: Id<"users">;
  consumeDecisionId?: Id<"resultAutomationDecisions">;
};

async function supersedeAfterHumanAllocation(ctx: MutationCtx, tenantId: Id<"tenants">, result: HumanPaymentResult) {
  const { opportunityId, actorUserId, previousRevision, consumeDecisionId } = result;
  const receipt = consumeDecisionId && await ctx.db.get("resultAutomationDecisions", consumeDecisionId);
  const receiptPaymentId = receipt && receipt.state === "applied" && receipt.tenantId === tenantId
    ? receipt.providerPaymentId : undefined;
  const now = Date.now();
  const allocations = await ctx.db.query("providerPayments")
    .withIndex("by_tenantId_and_opportunityId", (q) => q.eq("tenantId", tenantId).eq("opportunityId", opportunityId))
    .take(PAYMENT_ROWS_PER_DEAL_HOLD + 1);
  const ids = new Set(allocations.flatMap((row) => row.paymentRecordId && row.resolvedAt === now && row.resolvedByUserId === actorUserId
    ? [row._id] : []));
  if (receiptPaymentId) ids.add(receiptPaymentId);
  for (const id of ids) {
    const otherThan = id === receiptPaymentId ? consumeDecisionId : undefined;
    await supersedePaymentDecisions(ctx, { tenantId, _id: id }, otherThan);
    // noteHumanResult has already stood down the current revision on this
    // deal. Preserve older vetoes and retire this allocation's siblings.
    const stopped = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_providerPaymentId_and_state", (q) =>
        q.eq("tenantId", tenantId).eq("providerPaymentId", id).eq("state", "stopped"))
      .order("desc").take(retirementBatch + 1);
    for (const row of stopped) {
      if (row.opportunityId === opportunityId && row.humanResultRevision === previousRevision &&
          row.stopCode === "human_result" && row.resolvedByUserId === actorUserId && row.resolvedAt === now) {
        await ctx.db.patch("resultAutomationDecisions", row._id, {
          state: "superseded", supersededByDecisionId: otherThan,
        });
      }
    }
  }
}

export async function scheduleEvaluationsForLead(
  ctx: MutationCtx, tenantId: Id<"tenants">, leadId: Id<"leads">, cause: EvaluateCause,
  humanResult?: HumanPaymentResult,
): Promise<void> {
  const [tenant, lead] = await Promise.all([ctx.db.get("tenants", tenantId), ctx.db.get("leads", leadId)]);
  const settings = tenant?.resultAutomation;
  if (humanResult && (settings || humanResult.consumeDecisionId)) {
    await supersedeAfterHumanAllocation(ctx, tenantId, humanResult);
  }
  if (lead?.tenantId !== tenantId || !settings?.enabled ||
      (settings.kinds.payment_win.mode === "off" && settings.kinds.additional_payment.mode === "off")) return;

  const base = { tenantId, leadId, cause, cursor: null, activationVersion: settings.activationVersion };
  await ctx.scheduler.runAfter(0, leadPageRef, { ...base, lookup: "resolved" });
  await ctx.scheduler.runAfter(0, leadPageRef, { ...base, lookup: "candidate" });
  const identifiers = await ctx.db.query("leadIdentifiers").withIndex("by_leadId", (q) =>
    q.eq("leadId", leadId)).take(17);
  // Beyond the matcher's identity budget the repair sweep rechecks the
  // payments, including those on older aliases.
  if (lead.email) await ctx.scheduler.runAfter(0, leadPageRef, { ...base, lookup: "email" });
  for (const item of identifiers.slice(0, 16)) {
    if (item.tenantId === tenantId && item.type === "email" && item.confidence !== "suggested" &&
        item.value !== lead.email) {
      await ctx.scheduler.runAfter(0, leadPageRef, { ...base, lookup: "email", identifierId: item._id });
    }
  }
}

const disconnectedArgs = {
  tenantId: v.id("tenants"),
  connectionId: v.id("tenantPaymentConnections"),
  before: v.number(),
  cursor: v.union(v.null(), v.string()),
};
type DisconnectedArgs = ObjectType<typeof disconnectedArgs>;
const disconnectedRef = makeFunctionReference<"mutation", DisconnectedArgs>("automation/decisions:supersedeConnectionPage");

/** Retire one page in the disconnect mutation. The remaining pages retain its cutoff. */
async function disconnectPage(ctx: MutationCtx, args: DisconnectedArgs) {
  const page = await ctx.db.query("providerPayments")
    .withIndex("by_tenantId_and_connectionId_and_externalPaymentId", (q) =>
      q.eq("tenantId", args.tenantId).eq("connectionId", args.connectionId))
    .paginate({ cursor: args.cursor, numItems: 20, maximumBytesRead: 256 * 1024 });
  for (const payment of page.page) await supersedePaymentDecisions(ctx, payment, undefined, args.before);
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, disconnectedRef, { ...args, cursor: page.continueCursor });
  }
}

export const supersedeConnectionPage = internalMutation({
  args: disconnectedArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await disconnectPage(ctx, args);
    return null;
  },
});

export async function supersedeConnectionDecisions(
  ctx: MutationCtx, tenantId: Id<"tenants">, connectionId: Id<"tenantPaymentConnections">,
): Promise<void> {
  await disconnectPage(ctx, { tenantId, connectionId, before: Date.now() + 0.999, cursor: null });
}
