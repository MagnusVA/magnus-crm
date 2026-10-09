import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { log, reportError } from "../lib/observability/log";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { validateLeadTransition } from "../lib/statusTransitions";
import { syncCustomerPaymentSummary } from "../lib/paymentHelpers";
import { insertCustomerAggregate } from "../reporting/writeHooks";
import { leadDisplayString } from "../lib/leadDisplay";

const LEAD_OPPORTUNITY_LIMIT = 100;
const OPPORTUNITY_PAYMENT_LIMIT = 50;

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

  const lead = await ctx.db.get("leads", leadId);
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
    log.info("customer.conversion.skipped", {
      tenantId,
      leadId,
      customerId: existingCustomer._id,
      winningOpportunityId,
      reason: "customer_exists",
    });
    return null;
  }

  const currentStatus = lead.status;
  if (!validateLeadTransition(currentStatus, "converted")) {
    throw new Error(
      `Cannot convert lead with status "${currentStatus}". Only active leads can be converted.`,
    );
  }

  const opportunity = await ctx.db.get("opportunities", winningOpportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Winning opportunity not found");
  }
  if (opportunity.leadId !== leadId) {
    throw new Error("Winning opportunity does not belong to this lead");
  }

  const winningPayment = (
    await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId_and_recordedAt", (q) =>
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

  const program = await ctx.db.get("tenantPrograms", winningPayment.programId);
  if (!program || program.tenantId !== tenantId) {
    throw new Error("Program not found on winning payment");
  }
  const resolvedProgramId = program._id;
  const resolvedProgramName = program.name;
  if (!lead.email) {
    throw new Error("Cannot convert lead to customer: lead email is missing");
  }

  const now = Date.now();
  const customerId = await ctx.db.insert("customers", {
    tenantId,
    leadId,
    fullName: leadDisplayString(lead),
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

  await ctx.db.patch("leads", leadId, {
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
    .take(LEAD_OPPORTUNITY_LIMIT);
  if (leadOpportunities.length === LEAD_OPPORTUNITY_LIMIT) {
    // Opportunities past the limit keep payments without customerId/program.
    reportError(
      "customer.conversion.bound_hit",
      new Error("Conversion reached the lead opportunity limit"),
      {
        severity: "warning",
        fingerprint: "customer.bound_hit:lead_opportunities",
        tenantId,
        leadId,
        customerId,
        limit: LEAD_OPPORTUNITY_LIMIT,
      },
    );
  }

  let backfilledCount = 0;
  let opportunitiesAtPaymentLimit = 0;
  for (const candidateOpportunity of leadOpportunities) {
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId_and_recordedAt", (q) =>
        q.eq("opportunityId", candidateOpportunity._id),
      )
      .take(OPPORTUNITY_PAYMENT_LIMIT);
    if (payments.length === OPPORTUNITY_PAYMENT_LIMIT) {
      opportunitiesAtPaymentLimit += 1;
    }

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
        await ctx.db.patch("paymentRecords", payment._id, patch);
        backfilledCount += 1;
      }
    }
  }

  if (opportunitiesAtPaymentLimit > 0) {
    // Payments past the limit aren't relinked to the new customer.
    reportError(
      "customer.conversion.bound_hit",
      new Error("Conversion reached the opportunity payment limit"),
      {
        severity: "warning",
        fingerprint: "customer.bound_hit:opportunity_payments",
        tenantId,
        leadId,
        customerId,
        opportunitiesAtPaymentLimit,
        limit: OPPORTUNITY_PAYMENT_LIMIT,
      },
    );
  }

  await syncCustomerPaymentSummary(ctx, customerId);

  // The customer.converted domain event covers the conversion itself; this
  // line records the payment rows relinked to the new customer.
  log.info("customer.conversion.payments_linked", {
    tenantId,
    customerId,
    leadId,
    paymentsPatched: backfilledCount,
    opportunitiesScanned: leadOpportunities.length,
  });

  return customerId;
}
