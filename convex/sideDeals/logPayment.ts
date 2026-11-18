import { v } from "convex/values";
import { markAttendanceOwed } from "../payments/attendanceDebt";
import { noteHumanResult } from "../automation/humanResult";
import {
  allocateReconciledPayment,
  attachReconciledPaymentProof,
  finishReconciledPayment,
  providerIntentValidator,
  providerWaivesProof,
  readReconciliationDealPayments,
  reconcilePaymentWrite,
  reconciledPaymentFields,
} from "../payments/reconcileCheck";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { syncPersonEnrollments } from "../lib/enrollments";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { insertRecordedPayment } from "../lib/paymentWrite";
import { transitionOpportunity } from "../lib/opportunityActivity";
import {
  assertPaymentRow,
  resolveProgramForWrite,
  type PaymentOrigin,
} from "../lib/paymentHelpers";
import { WEB } from "../lib/outcomeCores";
import { checkPaymentProof, newPaymentFields } from "../lib/paymentProof";
import { paymentTypeValidator, resolvePaymentType } from "../lib/paymentTypes";
import { isSideDeal } from "../lib/sideDeals";
import { setSoldProgramCaches } from "../lib/soldProgramCache";
import { expirePendingStaleOpportunityNudges } from "../lib/staleOpportunityNudges";
import { canTakePayment, describeDealState, loadDealTasks } from "../opportunities/dealGuards";
import { requireTenantUser } from "../requireTenantUser";

export const logPayment = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    amount: v.number(),
    currency: v.string(),
    programId: v.id("tenantPrograms"),
    paymentType: paymentTypeValidator,
    proofFileId: v.optional(v.id("_storage")),
    provider: v.optional(providerIntentValidator),
  },
  returns: v.object({
    paymentId: v.id("paymentRecords"),
  }),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const { userId, tenantId, role } = actor;
    const now = Date.now();
    const isAdmin = role === "tenant_master" || role === "tenant_admin";

    const opportunity = await ctx.db.get("opportunities", args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found.");
    }
    if (!isSideDeal(opportunity)) {
      throw new Error("This mutation only accepts side-deal opportunities.");
    }
    if (!isAdmin && opportunity.assignedCloserId !== userId) {
      throw new Error("You are not the assigned closer for this opportunity.");
    }
    const dealPayments = await readReconciliationDealPayments(ctx, opportunity._id);
    const reconciliation = await reconcilePaymentWrite(ctx, opportunity, "side_deal", dealPayments, args.provider);
    if (reconciliation.action === "attach_existing") {
      const paymentId = reconciliation.paymentRecordId;
      if (await attachReconciledPaymentProof(ctx, paymentId, actor, args.proofFileId)) {
        await noteHumanResult(ctx, opportunity._id, actor);
      }
      return { paymentId };
    }

    if (!canTakePayment(opportunity, await loadDealTasks(ctx, opportunity._id))) {
      throw new Error(`A deal at "${describeDealState(opportunity)}" can't take a payment.`);
    }
    if (args.amount <= 0) {
      throw new Error("Payment amount must be greater than zero.");
    }
    if (!opportunity.assignedCloserId) {
      throw new Error("Opportunity must be assigned to a closer before payment.");
    }

    const currency = validateCurrency(args.currency);
    const amountMinor = toAmountMinor(args.amount);
    const program = await resolveProgramForWrite(ctx, tenantId, args.programId);
    const paymentType = resolvePaymentType(args.paymentType);
    const origin: PaymentOrigin = reconciliation.action === "insert_from_provider"
      ? "provider"
      : isAdmin ? "admin_side_deal" : "closer_side_deal";

    assertPaymentRow({
      tenantId,
      attributedCloserId: opportunity.assignedCloserId,
      recordedByUserId: userId,
      origin,
      opportunityId: args.opportunityId,
      programId: program._id,
      paymentType,
    });
    const whopWaivesProof = providerWaivesProof(reconciliation, amountMinor, currency);
    const proof = whopWaivesProof && !args.proofFileId
      ? null
      : await checkPaymentProof(ctx, { role, userId, proofFileId: args.proofFileId });
    const recordedFields = await newPaymentFields(ctx, tenantId, proof, WEB);

    const paymentId = await insertRecordedPayment(ctx, {
      tenantId,
      opportunityId: args.opportunityId,
      meetingId: undefined,
      attributedCloserId: opportunity.assignedCloserId,
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
      programId: program._id,
      programName: program.name,
    });
    await transitionOpportunity(ctx, args.opportunityId, {
      to: { stage: "closed", outcome: "won" },
      fields: { paymentReceivedAt: now, updatedAt: now },
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      occurredAt: now,
      metadata: { source: "side_deal", paymentId },
    });
    await expirePendingStaleOpportunityNudges(ctx, args.opportunityId);

    // The person's enrollments follow their payments, and their first one
    // makes them a customer, with or without an email
    // (docs/plans/phase-4-customers.md §4.1, §4.2).
    await syncPersonEnrollments(ctx, {
      tenantId,
      leadId: opportunity.leadId,
      now,
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment.recorded",
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      toStatus: "recorded",
      occurredAt: now,
      metadata: {
        opportunityId: args.opportunityId,
        amountMinor,
        currency,
        programId: program._id,
        ...(origin !== "provider" && { programName: program.name }),
        paymentType,
        origin,
        sideDeal: true,
      },
    });

    if (reconciliation.action === "insert_from_provider") {
      await markAttendanceOwed(ctx, opportunity._id);
    }
    await finishReconciledPayment(ctx, reconciliation, { actor, writer: "side_deal", opportunity, paymentId, now });
    return { paymentId };
  },
});
