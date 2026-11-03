import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { mutation, query } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { syncPersonEnrollments } from "../lib/enrollments";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { recordPayment } from "../lib/leadLifecycle";
import {
  assertPaymentRow,
  resolveProgramForWrite,
  type PaymentOrigin,
} from "../lib/paymentHelpers";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { assertCanRecordMeetingOutcome } from "../lib/outcomeEligibility";
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
import {
  insertPaymentAggregate,
} from "../reporting/writeHooks";

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
};

/**
 * Every check a meeting's payment makes, in the order `logPayment` always
 * made them, with no write. Throws the refusal.
 */
async function checkMeetingPayment(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: MeetingPaymentArgs,
  options: ProofCheckOptions = {},
) {
  assertCoreRole(actor, MEETING_PAYMENT_ROLES);
  const { userId, tenantId, role } = actor;

  const opportunity = await ctx.db.get("opportunities", args.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }
  if (role === "closer" && opportunity.assignedCloserId !== userId) {
    throw new Error("Not your opportunity");
  }

  const meeting = await ctx.db.get("meetings", args.meetingId);
  if (
    !meeting ||
    meeting.tenantId !== tenantId ||
    meeting.opportunityId !== args.opportunityId
  ) {
    throw new Error("Meeting does not belong to this opportunity");
  }
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
  const origin: PaymentOrigin =
    role === "closer" ? "closer_meeting" : "admin_meeting";

  assertPaymentRow({
    tenantId,
    attributedCloserId,
    recordedByUserId: userId,
    origin,
    opportunityId: args.opportunityId,
    programId: program._id,
    paymentType,
  });
  const proof =
    options.proof === "skip"
      ? null
      : await checkPaymentProof(ctx, { role, userId, proofFileId: args.proofFileId });

  return {
    proof,
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
    const checked = await checkMeetingPayment(ctx, actor, args, options);
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
  } = await checkMeetingPayment(ctx, actor, args);

  const recordedFields = await newPaymentFields(ctx, tenantId, proof, provenance);
  const paymentId = await ctx.db.insert("paymentRecords", {
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
    status: "recorded",
    statusChangedAt: now,
    recordedAt: now,
    origin,
    ...recordedFields,
  });
  await recordPayment(ctx, paymentId);
  await insertPaymentAggregate(ctx, paymentId);
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
      programName: program.name,
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
