import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import {
  applyPaymentStatsDelta,
  updateTenantStats,
} from "../lib/tenantStatsHelper";
import {
  assertPaymentRow,
  resolveProgramForWrite,
  syncCustomerPaymentSummary,
} from "../lib/paymentHelpers";
import { paymentTypeValidator, resolvePaymentType } from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import { insertPaymentAggregate } from "../reporting/writeHooks";
import { executeConversion } from "./conversion";

export const convertLeadToCustomer = mutation({
  args: {
    leadId: v.id("leads"),
    winningOpportunityId: v.id("opportunities"),
    winningMeetingId: v.optional(v.id("meetings")),
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

    const opportunity = await ctx.db.get(args.winningOpportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.status !== "payment_received") {
      throw new Error(
        `Cannot convert: winning opportunity must have status "payment_received", but has "${opportunity.status}". Record a payment first.`,
      );
    }

    const customerId = await executeConversion(ctx, {
      tenantId,
      leadId: args.leadId,
      convertedByUserId: userId,
      winningOpportunityId: args.winningOpportunityId,
      winningMeetingId: args.winningMeetingId,
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
  },
});

export const recordCustomerPayment = mutation({
  args: {
    customerId: v.id("customers"),
    amount: v.number(),
    currency: v.string(),
    programId: v.id("tenantPrograms"),
    paymentType: paymentTypeValidator,
    referenceCode: v.optional(v.string()),
    proofFileId: v.optional(v.id("_storage")),
    // Optional back-dated "paid at" timestamp. When omitted the server stamps
    // the current time, preserving existing behaviour. When provided it is
    // used as the row's `recordedAt` so revenue / trend reports bucket the
    // payment into the correct period.
    paidAt: v.optional(v.number()),
    // Optional free-form audit note (max 500 chars, trimmed).
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("[Customer] recordCustomerPayment called", {
      customerId: args.customerId,
      amount: args.amount,
      programId: args.programId,
      paymentType: args.paymentType,
      hasPaidAt: args.paidAt !== undefined,
      hasNote: !!args.note,
    });
    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.tenantId !== tenantId) {
      throw new Error("Customer not found");
    }

    if (args.amount <= 0) {
      throw new Error("Payment amount must be positive");
    }

    const currency = validateCurrency(args.currency);
    const amountMinor = toAmountMinor(args.amount);
    const now = Date.now();
    const program = await resolveProgramForWrite(ctx, tenantId, args.programId);
    const paymentType = resolvePaymentType(args.paymentType);

    // Guard: `paidAt` must be a finite past-or-present timestamp. Disallow
    // future-dated entries so backdated admin corrections can't land ahead
    // of the current period boundary.
    let paidAt = now;
    if (args.paidAt !== undefined) {
      if (!Number.isFinite(args.paidAt)) {
        throw new Error("Invalid paidAt timestamp");
      }
      if (args.paidAt > now) {
        throw new Error(
          "Paid at cannot be in the future. Pick today's date or earlier.",
        );
      }
      paidAt = args.paidAt;
    }

    const normalizedNote =
      args.note && args.note.trim().length > 0
        ? args.note.trim().slice(0, 500)
        : undefined;

    const row = {
      tenantId,
      opportunityId: undefined,
      attributedCloserId: undefined,
      recordedByUserId: userId,
      commissionable: false as const,
      customerId: args.customerId,
      originatingOpportunityId: customer.winningOpportunityId,
      amountMinor,
      currency,
      programId: program._id,
      programName: program.name,
      paymentType,
      referenceCode: args.referenceCode?.trim() || undefined,
      proofFileId: args.proofFileId ?? undefined,
      note: normalizedNote,
      status: "recorded" as const,
      statusChangedAt: now,
      // Use the caller-supplied `paidAt` (if any) as the effective reporting
      // timestamp. Falls back to `now` for forward-dated "today" entries.
      recordedAt: paidAt,
      contextType: "customer" as const,
      origin: "customer_direct" as const,
    };
    assertPaymentRow(row);

    const paymentId = await ctx.db.insert("paymentRecords", row);
    await insertPaymentAggregate(ctx, paymentId);
    await syncCustomerPaymentSummary(ctx, args.customerId);
    await applyPaymentStatsDelta(ctx, tenantId, {
      commissionable: false,
      paymentType,
      amountMinorDelta: amountMinor,
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment.recorded",
      source: "admin",
      actorUserId: userId,
      toStatus: "recorded",
      metadata: {
        customerId: args.customerId,
        originatingOpportunityId: customer.winningOpportunityId,
        amountMinor,
        currency,
        programId: program._id,
        programName: program.name,
        paymentType,
        commissionable: false,
        origin: "customer_direct",
        recordedByUserId: userId,
        paidAt,
        note: normalizedNote,
      },
      // Preserve the "when the admin performed this action" signal on the
      // event timeline; reporting uses `paymentRecords.recordedAt` for
      // financial bucketing instead.
      occurredAt: now,
    });

    console.log("[Customer] Post-conversion payment recorded", {
      paymentId,
      customerId: args.customerId,
      programId: program._id,
      paymentType,
    });

    return paymentId;
  },
});
