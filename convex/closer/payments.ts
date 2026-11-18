import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { mutation, query } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { syncPersonEnrollments } from "../lib/enrollments";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { insertRecordedPayment } from "../lib/paymentWrite";
import {
  assertPaymentRow,
  resolveProgramForWrite,
  type PaymentOrigin,
} from "../lib/paymentHelpers";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { assertCanRecordMeetingOutcome, isMeetingOutcomeEligible } from "../lib/outcomeEligibility";
import { transitionOpportunity } from "../lib/opportunityActivity";
import {
  assertCoreRole,
  provenanceMetadata,
  toCheckResult,
  WEB,
  type CheckResult,
  type CoreActor,
  type Provenance,
} from "../lib/outcomeCores";
import {
  paymentTypeValidator,
  resolvePaymentType,
  type PaymentType,
} from "../lib/paymentTypes";
import {
  checkPaymentProof,
  newPaymentFields,
  type ProofCheckOptions,
} from "../lib/paymentProof";
import { setSoldProgramCaches } from "../lib/soldProgramCache";
import { requireTenantUser } from "../requireTenantUser";
import { noteHumanResult } from "../automation/humanResult";
import { markAttendanceOwed } from "../payments/attendanceDebt";
import {
  allocateReconciledPayment,
  attachReconciledPaymentProof,
  finishReconciledPayment,
  loadMeetingPaymentTarget,
  providerIntentValidator,
  providerWaivesProof,
  readReconciliationDealPayments,
  reconcilePaymentWrite,
  reconciledPaymentFields,
  type InsertReconciliation,
  type ProviderIntent,
} from "../payments/reconcileCheck";
import { queueSecondOpinion } from "../secondOpinion/trigger";
import { fromSuggestionValidator, type FromSuggestion } from "../callInsights/validators";
import {
  markSuggestionUsed,
  resolveSuggestionRef,
  suggestionWaivesProof,
} from "../callInsights/suggest/state";

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"]);
    return await ctx.storage.generateUploadUrl();
  },
});

const MEETING_PAYMENT_ROLES = ["closer", "tenant_master", "tenant_admin"] as const;

export const logPayment = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
    amount: v.number(),
    currency: v.string(),
    programId: v.id("tenantPrograms"),
    paymentType: paymentTypeValidator,
    proofFileId: v.optional(v.id("_storage")),
    fromSuggestion: v.optional(fromSuggestionValidator),
    provider: v.optional(providerIntentValidator),
  },
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...MEETING_PAYMENT_ROLES]);
    return await recordMeetingPayment(ctx, actor, args, WEB);
  },
});

export type MeetingPaymentArgs = {
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
  /** In major units, as the dialog takes it. */
  amount: number;
  currency: string;
  programId: Id<"tenantPrograms">;
  paymentType: PaymentType;
  proofFileId?: Id<"_storage">;
  fromSuggestion?: FromSuggestion;
  provider?: ProviderIntent;
};

/**
 * Every check a meeting's payment makes, in the order `logPayment` always
 * made them, with no write. Throws the refusal.
 */
async function checkMeetingPayment(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: MeetingPaymentArgs,
  { opportunity, meeting }: Awaited<ReturnType<typeof loadMeetingPaymentTarget>>,
  options: ProofCheckOptions,
  reconciliation?: InsertReconciliation,
) {
  const { userId, tenantId, role } = actor;

  const now = Date.now();
  // A deal awaiting its call's result, which can always take a payment.
  assertCanRecordMeetingOutcome({
    meeting,
    opportunity,
    userId,
    role,
    now,
  });
  if (args.amount <= 0) {
    throw new Error("Payment amount must be positive");
  }

  const currency = validateCurrency(args.currency);
  const amountMinor = toAmountMinor(args.amount);
  const program = await resolveProgramForWrite(ctx, tenantId, args.programId);
  const paymentType = resolvePaymentType(args.paymentType);

  if (role !== "closer" && !opportunity.assignedCloserId) {
    throw new Error("Assign a closer before logging a payment");
  }
  const attributedCloserId =
    role === "closer" ? userId : opportunity.assignedCloserId!;
  const origin: PaymentOrigin = reconciliation?.action === "insert_from_provider"
    ? "provider"
    : role === "closer" ? "closer_meeting" : "admin_meeting";

  assertPaymentRow({
    tenantId,
    attributedCloserId,
    recordedByUserId: userId,
    origin,
    opportunityId: args.opportunityId,
    programId: program._id,
    paymentType,
  });
  // Suggestion tracking must not reject an otherwise valid save.
  const suggestion = args.fromSuggestion
    ? await resolveSuggestionRef(ctx, {
        tenantId,
        meetingId: meeting._id,
        ref: args.fromSuggestion,
      }).catch(() => null)
    : null;
  const whopWaivesProof = reconciliation && providerWaivesProof(reconciliation, amountMinor, currency);
  // Track suggestion waivers separately from Whop proof.
  const proofWaived =
    role === "closer" && !args.proofFileId && !whopWaivesProof &&
    reconciliation?.action !== "insert_and_link" && suggestionWaivesProof(suggestion);
  const proof =
    options.proof === "skip" || proofWaived || (whopWaivesProof && !args.proofFileId)
      ? null
      : await checkPaymentProof(ctx, { role, userId, proofFileId: args.proofFileId });

  return {
    proof,
    suggestion,
    proofWaived,
    userId,
    tenantId,
    role,
    opportunity,
    meeting,
    now,
    currency,
    amountMinor,
    program,
    paymentType,
    attributedCloserId,
    origin,
  };
}

/**
 * Whether `recordMeetingPayment` would take this payment, without writing:
 * the same checks, in the same order, with the refusal it would throw
 * returned as `{ ok: false, code, message }`. For a preview before the
 * write (decision 17).
 */
export async function checkMeetingPaymentAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: MeetingPaymentArgs,
  options: ProofCheckOptions = {},
): Promise<
  CheckResult<{
    opportunityId: Id<"opportunities">;
    meetingId: Id<"meetings">;
    leadId: Id<"leads">;
    amountMinor: number;
    currency: string;
    programId: Id<"tenantPrograms">;
    programName: string;
    paymentType: PaymentType;
  }>
> {
  return await toCheckResult(async () => {
    assertCoreRole(actor, MEETING_PAYMENT_ROLES);
    const target = await loadMeetingPaymentTarget(ctx, actor, args);
    const dealPayments = await readReconciliationDealPayments(ctx, target.opportunity._id);
    await reconcilePaymentWrite(ctx, target.opportunity, "meeting", dealPayments);
    const checked = await checkMeetingPayment(ctx, actor, args, target, options);
    return {
      opportunityId: checked.opportunity._id,
      meetingId: checked.meeting._id,
      leadId: checked.opportunity.leadId,
      amountMinor: checked.amountMinor,
      currency: checked.currency,
      programId: checked.program._id,
      programName: checked.program.name,
      paymentType: checked.paymentType,
    };
  });
}

/**
 * Logs a payment on a meeting's result: the deal closes won and the call is
 * recorded held. The core of `logPayment` (docs/plans/closer-assistant.md
 * §6.3), shared with the agent's tool. `provenance` tags the payment's own
 * event for an agent.
 */
export async function recordMeetingPayment(
  ctx: MutationCtx,
  actor: CoreActor,
  args: MeetingPaymentArgs,
  provenance: Provenance,
): Promise<Id<"paymentRecords">> {
  assertCoreRole(actor, MEETING_PAYMENT_ROLES);
  const target = await loadMeetingPaymentTarget(ctx, actor, args);
  const dealPayments = await readReconciliationDealPayments(ctx, target.opportunity._id);
  const reconciliation = await reconcilePaymentWrite(ctx, target.opportunity, "meeting", dealPayments, args.provider);
  if (reconciliation.action === "attach_existing") {
    const { meeting, opportunity } = target;
    const now = Date.now();
    if (meeting.status !== "held") {
      if (meeting.status !== "scheduled") {
        throw new Error(`Meeting is not scheduled (current: ${meeting.status})`);
      }
      if (actor.role === "closer" && !isMeetingOutcomeEligible(meeting, now)) {
        throw new Error("Outcome actions open 5 minutes before the scheduled time.");
      }
      await completeMeetingForOutcome(ctx, {
        meetingId: meeting._id,
        opportunityId: opportunity._id,
        toMeetingStatus: "held",
        recordedAt: now,
        extraMeetingPatch: { attendanceOwedSince: undefined },
      });
    }
    const attached = await attachReconciledPaymentProof(ctx, reconciliation.paymentRecordId, actor, args.proofFileId);
    if (attached || meeting.status === "scheduled") await noteHumanResult(ctx, opportunity._id, actor);
    return reconciliation.paymentRecordId;
  }
  const {
    userId,
    tenantId,
    role,
    opportunity,
    meeting,
    now,
    currency,
    amountMinor,
    program,
    paymentType,
    attributedCloserId,
    origin,
    proof,
    suggestion,
    proofWaived,
  } = await checkMeetingPayment(ctx, actor, args, target, {}, reconciliation);

  const recordedFields = await newPaymentFields(ctx, tenantId, proof, provenance);
  const paymentId = await insertRecordedPayment(ctx, {
    tenantId,
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    attributedCloserId,
    recordedByUserId: userId,
    amountMinor,
    currency,
    programId: program._id,
    programName: program.name,
    paymentType,
    proofFileId: args.proofFileId ?? undefined,
    recordedAt: now,
    origin,
    ...recordedFields,
    ...reconciledPaymentFields(reconciliation),
  });
  await allocateReconciledPayment(ctx, reconciliation, paymentId, actor, now);
  await setSoldProgramCaches(ctx, {
    tenantId,
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    programId: program._id,
    programName: program.name,
  });

  await transitionOpportunity(ctx, args.opportunityId, {
    to: { stage: "closed", outcome: "won" },
    fields: { paymentReceivedAt: now, updatedAt: now },
    source: role === "closer" ? "closer" : "admin",
    actorUserId: userId,
    metadata: { paymentId },
    occurredAt: now,
  });
  await completeMeetingForOutcome(ctx, {
    meetingId: meeting._id,
    opportunityId: opportunity._id,
    toMeetingStatus: "held",
    recordedAt: now,
  });

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "payment",
    entityId: paymentId,
    eventType: "payment.recorded",
    source: role === "closer" ? "closer" : "admin",
    actorUserId: userId,
    toStatus: "recorded",
    metadata: {
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      amountMinor,
      currency,
      programId: program._id,
      ...(origin !== "provider" && { programName: program.name }),
      paymentType,
      attributedCloserId,
      recordedByUserId: userId,
      origin,
      ...provenanceMetadata(provenance),
    },
    occurredAt: now,
  });

  // The person's enrollments follow their payments, and their first one
  // makes them a customer (docs/plans/phase-4-customers.md §4.1, §4.2).
  await syncPersonEnrollments(ctx, {
    tenantId,
    leadId: opportunity.leadId,
    now,
    source: role === "closer" ? "closer" : "admin",
    actorUserId: userId,
  });

  if (suggestion) {
    await markSuggestionUsed(ctx, {
      state: suggestion,
      userId,
      changedFields: args.fromSuggestion?.changedFields,
      paymentId,
      ...(proofWaived ? { proofWaived: true } : {}),
    }).catch(() => undefined);
  }

  // A recorded result plus a matched recording starts Jev's check (§6.9).
  await queueSecondOpinion(ctx, { meetingId: meeting._id, trigger: "result_recorded" });

  if (reconciliation.action === "insert_from_provider") {
    await markAttendanceOwed(ctx, opportunity._id, { exceptMeetingId: meeting._id });
  }
  await finishReconciledPayment(ctx, reconciliation, { actor, writer: "meeting", opportunity, paymentId, now, meeting });
  return paymentId;
}

export const getPaymentProofUrl = query({
  args: { paymentRecordId: v.id("paymentRecords") },
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const record = await ctx.db.get("paymentRecords", paymentRecordId);
    if (!record || record.tenantId !== tenantId || !record.proofFileId) {
      return null;
    }

    return await ctx.storage.getUrl(record.proofFileId);
  },
});
