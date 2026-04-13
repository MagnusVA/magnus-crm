import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { validateLeadTransition } from "../lib/statusTransitions";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor } from "../lib/formatMoney";
import { updateTenantStats } from "../lib/tenantStatsHelper";

/**
 * Core conversion logic — creates a customer record from a lead.
 *
 * Called by:
 * 1. Auto-conversion in logPayment (after opportunity → payment_received)
 * 2. Manual conversion from Lead Manager (admin action)
 *
 * Returns the new customer ID, or null if a customer already exists for this lead.
 */
export async function executeConversion(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    convertedByUserId: Id<"users">;
    winningOpportunityId: Id<"opportunities">;
    winningMeetingId?: Id<"meetings">;
    programType?: string;
    notes?: string;
  },
): Promise<Id<"customers"> | null> {
  const {
    tenantId,
    leadId,
    convertedByUserId,
    winningOpportunityId,
    winningMeetingId,
    programType,
    notes,
  } = args;

  // 1. Load and validate the lead
  const lead = await ctx.db.get(leadId);
  if (!lead || lead.tenantId !== tenantId) {
    throw new Error("Lead not found");
  }

  // 2. Check if customer already exists for this lead
  const existingCustomer = await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .first();

  if (existingCustomer) {
    console.log("[Customer] Customer already exists for lead", {
      leadId,
      customerId: existingCustomer._id,
    });
    return null; // Caller handles returning-customer case
  }

  // 3. Validate lead status transition
  const currentStatus = lead.status ?? "active";
  if (!validateLeadTransition(currentStatus, "converted")) {
    throw new Error(
      `Cannot convert lead with status "${currentStatus}". Only active leads can be converted.`,
    );
  }

  // 4. Validate the winning opportunity
  const opportunity = await ctx.db.get(winningOpportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Winning opportunity not found");
  }
  if (opportunity.leadId !== leadId) {
    throw new Error("Winning opportunity does not belong to this lead");
  }

  // 5. Resolve program type from event type config if not provided
  let resolvedProgramType = programType;
  if (!resolvedProgramType && opportunity.eventTypeConfigId) {
    const config = await ctx.db.get(opportunity.eventTypeConfigId);
    if (config) {
      resolvedProgramType = config.displayName ?? undefined;
    }
  }

  const now = Date.now();

  // 6. Create customer record with denormalized lead data
  const customerId = await ctx.db.insert("customers", {
    tenantId,
    leadId,
    fullName: lead.fullName ?? lead.email,
    email: lead.email,
    phone: lead.phone,
    socialHandles: lead.socialHandles,
    convertedAt: now,
    convertedByUserId,
    winningOpportunityId,
    winningMeetingId,
    programType: resolvedProgramType,
    notes,
    status: "active",
    totalPaidMinor: 0,
    totalPaymentCount: 0,
    createdAt: now,
  });

  console.log("[Customer] Customer created", {
    customerId,
    leadId,
    winningOpportunityId,
  });

  // 7. Transition lead to "converted"
  await ctx.db.patch(leadId, {
    status: "converted",
    updatedAt: now,
  });
  await updateTenantStats(ctx, tenantId, {
    totalCustomers: 1,
    totalLeads: lead.status === "active" ? -1 : 0,
  });
  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "customer",
    entityId: customerId,
    eventType: "customer.converted",
    source: "system",
    actorUserId: convertedByUserId,
    metadata: {
      leadId,
      winningOpportunityId,
      winningMeetingId,
    },
    occurredAt: now,
  });
  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "lead",
    entityId: leadId,
    eventType: "lead.status_changed",
    source: "system",
    actorUserId: convertedByUserId,
    fromStatus: currentStatus,
    toStatus: "converted",
    occurredAt: now,
  });

  console.log("[Customer] Lead status → converted", { leadId });

  // 8. Backfill customerId on all existing payment records for this lead's opportunities
  const leadOpportunities = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .take(100);

  let backfilledCount = 0;
  for (const opp of leadOpportunities) {
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opp._id))
      .take(50);

    for (const payment of payments) {
      if (!payment.customerId) {
        await ctx.db.patch(payment._id, { customerId });
        backfilledCount++;
      }
    }
  }

  const customerPayments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_customerId", (q) => q.eq("customerId", customerId))
    .take(100);
  const nonDisputedPayments = customerPayments.filter(
    (payment) => payment.status !== "disputed",
  );
  const currencies = Array.from(
    new Set(nonDisputedPayments.map((payment) => payment.currency)),
  );
  await ctx.db.patch(customerId, {
    totalPaidMinor: nonDisputedPayments.reduce(
      (sum, payment) => sum + (payment.amountMinor ?? toAmountMinor(payment.amount)),
      0,
    ),
    totalPaymentCount: nonDisputedPayments.length,
    paymentCurrency: currencies.length === 1 ? currencies[0] : undefined,
  });

  console.log("[Customer] Backfilled customerId on payment records", {
    customerId,
    backfilledCount,
  });

  return customerId;
}
