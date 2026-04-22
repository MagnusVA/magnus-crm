import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { validateLeadTransition } from "../lib/statusTransitions";
import { syncCustomerPaymentSummary } from "../lib/paymentHelpers";
import { insertCustomerAggregate } from "../reporting/writeHooks";

/**
 * Core conversion logic — creates a customer record from a lead.
 *
 * Called by:
 * 1. Auto-conversion in logPayment (after opportunity → payment_received)
 * 2. Auto-conversion in reminder/review payment flows
 * 3. Manual conversion from Lead Manager (admin action)
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
    notes?: string;
  },
): Promise<Id<"customers"> | null> {
  const {
    tenantId,
    leadId,
    convertedByUserId,
    winningOpportunityId,
    winningMeetingId,
    notes,
  } = args;

  const lead = await ctx.db.get(leadId);
  if (!lead || lead.tenantId !== tenantId) {
    throw new Error("Lead not found");
  }

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
    return null;
  }

  const currentStatus = lead.status;
  if (!validateLeadTransition(currentStatus, "converted")) {
    throw new Error(
      `Cannot convert lead with status "${currentStatus}". Only active leads can be converted.`,
    );
  }

  const opportunity = await ctx.db.get(winningOpportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Winning opportunity not found");
  }
  if (opportunity.leadId !== leadId) {
    throw new Error("Winning opportunity does not belong to this lead");
  }

  const winningPayment = (
    await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", winningOpportunityId),
      )
      .order("desc")
      .take(10)
  ).find((payment) => payment.status !== "disputed");
  if (!winningPayment) {
    throw new Error("Cannot convert lead to customer: no payment found on winning opportunity");
  }
  if (!winningPayment.programId) {
    throw new Error(
      "Cannot convert lead to customer: winning payment is missing programId",
    );
  }

  const program = await ctx.db.get(winningPayment.programId);
  if (!program || program.tenantId !== tenantId) {
    throw new Error("Program not found on winning payment");
  }
  const resolvedProgramId = program._id;
  const resolvedProgramName = program.name;

  const now = Date.now();
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
    programId: resolvedProgramId,
    programName: resolvedProgramName,
    notes,
    status: "active",
    totalPaidMinor: 0,
    totalPaymentCount: 0,
    createdAt: now,
  });

  await insertCustomerAggregate(ctx, customerId);

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
      programId: resolvedProgramId,
      programName: resolvedProgramName,
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

  const leadOpportunities = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .take(100);

  let backfilledCount = 0;
  for (const candidateOpportunity of leadOpportunities) {
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", candidateOpportunity._id),
      )
      .take(50);

    for (const payment of payments) {
      const patch: Partial<Doc<"paymentRecords">> = {};
      if (!payment.customerId) {
        patch.customerId = customerId;
      }
      if (!payment.programId) {
        patch.programId = resolvedProgramId;
      }
      if (payment.programName !== resolvedProgramName) {
        patch.programName = resolvedProgramName;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(payment._id, patch);
        backfilledCount += 1;
      }
    }
  }

  await syncCustomerPaymentSummary(ctx, customerId);

  console.log("[Customer] Conversion completed", {
    customerId,
    leadId,
    winningOpportunityId,
    backfilledCount,
    resolvedProgramId,
    resolvedProgramName,
  });

  return customerId;
}
