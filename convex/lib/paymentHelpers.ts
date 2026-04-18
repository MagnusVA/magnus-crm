import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { emitDomainEvent } from "./domainEvents";
import { updateTenantStats } from "./tenantStatsHelper";
import { deleteCustomerAggregate } from "../reporting/writeHooks";

export async function syncCustomerPaymentSummary(
  ctx: MutationCtx,
  customerId: Id<"customers">,
): Promise<void> {
  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_customerId", (q) => q.eq("customerId", customerId))
    .take(100);

  const nonDisputedPayments = payments.filter(
    (payment) => payment.status !== "disputed",
  );
  const currencies = Array.from(
    new Set(nonDisputedPayments.map((payment) => payment.currency)),
  );

  await ctx.db.patch(customerId, {
    totalPaidMinor: nonDisputedPayments.reduce(
      (sum, payment) => sum + payment.amountMinor,
      0,
    ),
    totalPaymentCount: nonDisputedPayments.length,
    paymentCurrency: currencies.length === 1 ? currencies[0] : undefined,
  });
}

export async function expirePendingFollowUpsForOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  actorUserId?: Id<"users">,
): Promise<number> {
  const pendingFollowUps = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status", (q) =>
      q.eq("opportunityId", opportunityId).eq("status", "pending"),
    )
    .take(50);

  const now = Date.now();
  for (const followUp of pendingFollowUps) {
    await ctx.db.patch(followUp._id, { status: "expired" });
    await emitDomainEvent(ctx, {
      tenantId: followUp.tenantId,
      entityType: "followUp",
      entityId: followUp._id,
      eventType: "followUp.expired",
      source: "admin",
      actorUserId,
      fromStatus: "pending",
      toStatus: "expired",
      reason: "review_disputed",
      occurredAt: now,
    });
  }

  return pendingFollowUps.length;
}

export async function rollbackCustomerConversionIfEmpty(
  ctx: MutationCtx,
  args: {
    customerId: Id<"customers">;
    opportunityId: Id<"opportunities">;
    actorUserId: Id<"users">;
  },
): Promise<{ rolledBack: boolean }> {
  const customer = await ctx.db.get(args.customerId);
  if (!customer) {
    return { rolledBack: false };
  }

  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
    .take(100);
  const nonDisputedPayments = payments.filter(
    (payment) => payment.status !== "disputed",
  );

  if (nonDisputedPayments.length > 0) {
    await syncCustomerPaymentSummary(ctx, args.customerId);
    return { rolledBack: false };
  }

  if (customer.winningOpportunityId !== args.opportunityId) {
    await syncCustomerPaymentSummary(ctx, args.customerId);
    return { rolledBack: false };
  }

  const now = Date.now();
  for (const payment of payments) {
    await ctx.db.patch(payment._id, { customerId: undefined });
  }

  const lead = await ctx.db.get(customer.leadId);

  await deleteCustomerAggregate(ctx, customer._id);
  await ctx.db.delete(args.customerId);

  if (lead && lead.status === "converted") {
    await ctx.db.patch(lead._id, {
      status: "active",
      updatedAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId: lead.tenantId,
      entityType: "lead",
      entityId: lead._id,
      eventType: "lead.status_changed",
      source: "admin",
      actorUserId: args.actorUserId,
      fromStatus: "converted",
      toStatus: "active",
      reason: "customer_conversion_rolled_back_via_dispute",
      occurredAt: now,
    });
  }

  await updateTenantStats(ctx, customer.tenantId, {
    totalCustomers: -1,
    totalLeads: lead?.status === "converted" ? 1 : 0,
  });

  await emitDomainEvent(ctx, {
    tenantId: customer.tenantId,
    entityType: "customer",
    entityId: args.customerId,
    eventType: "customer.conversion_rolled_back",
    source: "admin",
    actorUserId: args.actorUserId,
    reason: "review_disputed",
    metadata: {
      leadId: customer.leadId,
      winningOpportunityId: args.opportunityId,
      paymentsOrphaned: payments.length,
    },
    occurredAt: now,
  });

  return { rolledBack: true };
}
