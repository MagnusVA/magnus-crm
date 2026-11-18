import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { expectedError } from "../lib/observability/errors";
import { refreshProviderPaymentReview } from "./match";

type Payment = Doc<"providerPayments">;
type AllocationCommand = Doc<"providerPaymentAllocationCommands">["command"];

export async function isAllocationRetry(
  ctx: MutationCtx,
  payment: Payment,
  expectedAllocationRevision: number,
  command: AllocationCommand,
) {
  if (payment.allocationRevision === expectedAllocationRevision) return false;
  const prior = await ctx.db.query("providerPaymentAllocationCommands")
    .withIndex("by_tenantId_and_providerPaymentId_and_expectedAllocationRevision", (q) => q
      .eq("tenantId", payment.tenantId)
      .eq("providerPaymentId", payment._id)
      .eq("expectedAllocationRevision", expectedAllocationRevision))
    .unique();
  const applied = prior?.command;
  if (applied?.kind === command.kind && applied.paymentRecordId === command.paymentRecordId &&
      (applied.kind === "unlink" ||
        (command.kind === "link" && applied.acknowledgeAmountDifference === command.acknowledgeAmountDifference))) {
    return true;
  }
  throw allocationChanged();
}

export function allocationChanged() {
  return expectedError("provider_payment.changed", "Someone else changed this payment. Reload to see the current state.");
}

export async function rememberAllocationCommand(
  ctx: MutationCtx,
  payment: Payment,
  command: AllocationCommand,
) {
  await ctx.db.insert("providerPaymentAllocationCommands", {
    tenantId: payment.tenantId,
    providerPaymentId: payment._id,
    expectedAllocationRevision: payment.allocationRevision,
    command,
  });
}

/** Clear the active pointer. The excluded CRM row keeps its provider provenance. */
export async function clearActiveAllocation(
  ctx: MutationCtx,
  record: Doc<"paymentRecords">,
) {
  if (!record.providerPaymentId) return;
  const payment = await ctx.db.get("providerPayments", record.providerPaymentId);
  if (payment?.tenantId !== record.tenantId || payment.paymentRecordId !== record._id) return;

  const bindingLimit = 100;
  const bindings = await ctx.db.query("paymentProviderBindings")
    .withIndex("by_tenantId_and_kind_and_enabled_and_anchorPaymentRecordId", (q) => q
      .eq("tenantId", payment.tenantId).eq("kind", "membership_deal").eq("enabled", true)
      .eq("binding.anchorPaymentRecordId", record._id))
    .take(bindingLimit + 1);
  if (bindings.length > bindingLimit) {
    throw expectedError("provider_payment.binding_limit", "Too many membership bindings to verify.");
  }
  for (const binding of bindings) {
    await ctx.db.patch("paymentProviderBindings", binding._id, {
      enabled: false,
      disabledReason: "anchor_undone",
      version: binding.version + 1,
    });
  }
  await ctx.db.patch("providerPayments", payment._id, {
    paymentRecordId: undefined,
    allocationRevision: payment.allocationRevision + 1,
    opportunityId: undefined,
    leadId: undefined,
    matchMethod: undefined,
    reviewState: "needs_person",
    reviewReason: undefined,
    candidateLeadId: undefined,
    candidateOpportunityId: undefined,
    matchedAt: undefined,
    dismissReason: undefined,
    resolvedAt: undefined,
    resolvedByUserId: undefined,
    adverseReviewAt: undefined,
  });
  if (payment.status === "paid" && payment.totalMinor !== 0) {
    await refreshProviderPaymentReview(ctx, payment._id);
  }
}
