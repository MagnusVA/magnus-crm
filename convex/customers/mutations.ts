import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { executeConversion } from "./conversion";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { insertPaymentAggregate } from "../reporting/writeHooks";
import { updateTenantStats } from "../lib/tenantStatsHelper";

/**
 * Manually convert a lead to a customer.
 *
 * Admin-only action from the Lead Manager detail page.
 * Requires selecting a winning opportunity (must be payment_received).
 */
export const convertLeadToCustomer = mutation({
  args: {
    leadId: v.id("leads"),
    winningOpportunityId: v.id("opportunities"),
    winningMeetingId: v.optional(v.id("meetings")),
    programType: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("[Customer] convertLeadToCustomer called", {
      leadId: args.leadId,
      winningOpportunityId: args.winningOpportunityId,
    });
    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Validate winning opportunity has payment_received status
    const opportunity = await ctx.db.get(args.winningOpportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.status !== "payment_received") {
      throw new Error(
        `Cannot convert: winning opportunity must have status "payment_received", ` +
          `but has "${opportunity.status}". Record a payment first.`,
      );
    }

    const customerId = await executeConversion(ctx, {
      tenantId,
      leadId: args.leadId,
      convertedByUserId: userId,
      winningOpportunityId: args.winningOpportunityId,
      winningMeetingId: args.winningMeetingId,
      programType: args.programType,
      notes: args.notes,
    });

    if (!customerId) {
      throw new Error(
        "A customer record already exists for this lead. Check the Customers page.",
      );
    }

    return customerId;
  },
});

/**
 * Update a customer's status (active, paused, churned).
 *
 * Admin-only. Status changes are the only edit allowed in v0.5.
 */
export const updateCustomerStatus = mutation({
  args: {
    customerId: v.id("customers"),
    status: v.union(
      v.literal("active"),
      v.literal("churned"),
      v.literal("paused"),
    ),
  },
  handler: async (ctx, args) => {
    console.log("[Customer] updateCustomerStatus called", {
      customerId: args.customerId,
      newStatus: args.status,
    });
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.tenantId !== tenantId) {
      throw new Error("Customer not found");
    }

    const now = Date.now();
    await ctx.db.patch(args.customerId, {
      status: args.status,
      churnedAt: args.status === "churned" ? now : undefined,
      pausedAt: args.status === "paused" ? now : undefined,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "customer",
      entityId: args.customerId,
      eventType: "customer.status_changed",
      source: "admin",
      fromStatus: customer.status,
      toStatus: args.status,
      occurredAt: now,
    });
    console.log("[Customer] Status updated", {
      customerId: args.customerId,
      from: customer.status,
      to: args.status,
    });
  },
});

/**
 * Record a payment directly against a customer (post-conversion).
 *
 * Use case: payment plan installments, upsells, renewals.
 * No meeting or opportunity context required.
 */
export const recordCustomerPayment = mutation({
  args: {
    customerId: v.id("customers"),
    amount: v.number(),
    currency: v.string(),
    provider: v.string(),
    referenceCode: v.optional(v.string()),
    proofFileId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    console.log("[Customer] recordCustomerPayment called", {
      customerId: args.customerId,
      amount: args.amount,
    });
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.tenantId !== tenantId) {
      throw new Error("Customer not found");
    }

    // Closer authorization: can only record payments on their own customers
    // "Own" = the closer is the convertedByUserId (they closed the deal)
    if (role === "closer" && customer.convertedByUserId !== userId) {
      throw new Error("Not your customer");
    }

    // Validate amount
    if (args.amount <= 0) {
      throw new Error("Payment amount must be positive");
    }

    const currency = validateCurrency(args.currency);

    const provider = args.provider.trim();
    if (!provider) {
      throw new Error("Provider is required");
    }

    const now = Date.now();
    const amountMinor = toAmountMinor(args.amount);
    const loggedByAdminUserId = role === "closer" ? undefined : userId;
    const paymentId = await ctx.db.insert("paymentRecords", {
      tenantId,
      closerId: userId,
      customerId: args.customerId,
      amountMinor,
      currency,
      provider,
      referenceCode: args.referenceCode?.trim() || undefined,
      proofFileId: args.proofFileId ?? undefined,
      status: "recorded",
      statusChangedAt: now,
      recordedAt: now,
      contextType: "customer",
      origin: "customer_flow",
      loggedByAdminUserId,
    });
    await insertPaymentAggregate(ctx, paymentId);
    const customerPayments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
      .take(100);
    const nonDisputedPayments = customerPayments.filter(
      (payment) => payment.status !== "disputed",
    );
    const currencies = Array.from(
      new Set(nonDisputedPayments.map((payment) => payment.currency)),
    );
    await ctx.db.patch(args.customerId, {
      totalPaidMinor: nonDisputedPayments.reduce(
        (sum, payment) => sum + payment.amountMinor,
        0,
      ),
      totalPaymentCount: nonDisputedPayments.length,
      paymentCurrency: currencies.length === 1 ? currencies[0] : undefined,
    });
    await updateTenantStats(ctx, tenantId, {
      totalPaymentRecords: 1,
      totalRevenueMinor: amountMinor,
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
        customerId: args.customerId,
        amountMinor,
        currency,
        origin: "customer_flow",
        ...(loggedByAdminUserId ? { loggedByAdminUserId } : {}),
      },
      occurredAt: now,
    });

    console.log("[Customer] Post-conversion payment recorded", {
      paymentId,
      customerId: args.customerId,
    });

    return paymentId;
  },
});
