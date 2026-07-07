import { v } from "convex/values";
import { mutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import {
  assertPaymentRow,
  syncCustomerPaymentSummary,
  type CommissionableOrigin,
} from "../lib/paymentHelpers";
import { paymentTypeValidator, resolvePaymentType } from "../lib/paymentTypes";
import { applyPaymentStatsDelta } from "../lib/tenantStatsHelper";
import { requireTenantUser } from "../requireTenantUser";
import {
  insertPaymentAggregate,
  replacePaymentAggregate,
} from "../reporting/writeHooks";

/**
 * Records an ADDITIONAL commissionable payment against an already-won
 * opportunity (`status === "payment_received"`), for the case where a customer
 * makes a further payment after the initial win. Unlike every other payment
 * path, this does NOT transition the opportunity status (the deal is already
 * won / terminal) and does NOT run conversion (a customer already exists).
 *
 * Attribution follows the "any closer, self-credit" rule: a closer credits
 * themselves; an admin recording on behalf credits the opportunity's assigned
 * closer. The row is commissionable, so it flows into the Sales Calls / revenue
 * dashboards and the admin billing review queue automatically.
 */
export const recordAdditionalPayment = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    amount: v.number(),
    currency: v.string(),
    paymentType: paymentTypeValidator,
    proofFileId: v.optional(v.id("_storage")),
    fathomLink: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.object({
    paymentId: v.id("paymentRecords"),
    customerId: v.optional(v.id("customers")),
  }),
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const isAdmin = role === "tenant_master" || role === "tenant_admin";

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found.");
    }

    // Gate: additional payments are only for opportunities that are already won.
    if (opportunity.status !== "payment_received") {
      throw new Error(
        `Additional payments can only be added to a won opportunity. This opportunity is "${opportunity.status}".`,
      );
    }

    if (!Number.isFinite(args.amount) || args.amount <= 0) {
      throw new Error("Payment amount must be a positive number.");
    }

    // Attribution: closers self-credit; admins record on behalf of the
    // opportunity's assigned closer. A commissionable row must have an
    // attributed closer, so an admin cannot record on an unassigned opportunity.
    let attributedCloserId: Id<"users">;
    let origin: CommissionableOrigin;
    if (isAdmin) {
      if (!opportunity.assignedCloserId) {
        throw new Error(
          "This opportunity has no assigned closer to attribute the payment to.",
        );
      }
      attributedCloserId = opportunity.assignedCloserId;
      origin = "admin_additional";
    } else {
      attributedCloserId = userId;
      origin = "closer_additional";
    }

    const currency = validateCurrency(args.currency);
    const amountMinor = toAmountMinor(args.amount);

    // The program is inherited from the opportunity's sold program — the
    // closer does not pick it. We read it directly (rather than via
    // resolveProgramForWrite) so a later-archived program does not block
    // legitimate follow-on payments on an already-won deal.
    if (!opportunity.soldProgramId) {
      throw new Error(
        "This opportunity has no sold program on record to attribute the payment to.",
      );
    }
    const program = await ctx.db.get(opportunity.soldProgramId);
    if (!program || program.tenantId !== tenantId) {
      throw new Error("Sold program for this opportunity was not found.");
    }
    const paymentType = resolvePaymentType(args.paymentType);

    // Validate the optional Fathom link the same way the codebase validates
    // other external URLs: parse it and require an http/https protocol.
    let fathomLink: string | undefined;
    if (args.fathomLink !== undefined) {
      const trimmed = args.fathomLink.trim();
      if (trimmed.length > 0) {
        try {
          const parsed = new URL(trimmed);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("Invalid URL protocol");
          }
        } catch {
          throw new Error(
            `Invalid Fathom link "${trimmed}". Expected a valid http/https URL.`,
          );
        }
        fathomLink = trimmed;
      }
    }

    const normalizedNote =
      args.note && args.note.trim().length > 0
        ? args.note.trim().slice(0, 500)
        : undefined;

    assertPaymentRow({
      tenantId,
      commissionable: true,
      attributedCloserId,
      recordedByUserId: userId,
      origin,
      contextType: "opportunity",
      opportunityId: args.opportunityId,
      customerId: undefined,
      programId: program._id,
      paymentType,
    });

    const paymentId = await ctx.db.insert("paymentRecords", {
      tenantId,
      opportunityId: args.opportunityId,
      meetingId: undefined,
      attributedCloserId,
      recordedByUserId: userId,
      commissionable: true,
      amountMinor,
      currency,
      programId: program._id,
      programName: program.name,
      paymentType,
      proofFileId: args.proofFileId ?? undefined,
      fathomLink,
      note: normalizedNote,
      status: "recorded",
      statusChangedAt: now,
      recordedAt: now,
      contextType: "opportunity",
      origin,
    });

    const paymentBeforeCustomerLink = await insertPaymentAggregate(
      ctx,
      paymentId,
    );

    // Link the payment to the existing customer (the opportunity is already
    // won, so a customer record exists) so the customer "Total Paid" rollup
    // stays accurate. We deliberately do NOT touch the opportunity status,
    // sold-program cache, or run conversion again.
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
      )
      .first();

    if (customer) {
      await ctx.db.patch(paymentId, { customerId: customer._id });
      await replacePaymentAggregate(ctx, paymentBeforeCustomerLink, paymentId);
      await syncCustomerPaymentSummary(ctx, customer._id);
    }

    // Revenue delta only — the deal was already counted as won, and the
    // opportunity is already inactive, so no wonDeal / activeOpportunity change.
    await applyPaymentStatsDelta(ctx, tenantId, {
      commissionable: true,
      paymentType,
      amountMinorDelta: amountMinor,
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
        programName: program.name,
        paymentType,
        origin,
        commissionable: true,
        attributedCloserId,
        recordedByUserId: userId,
        additionalPayment: true,
        hasProofFile: Boolean(args.proofFileId),
        hasFathomLink: Boolean(fathomLink),
        note: normalizedNote,
      },
    });

    console.log("[Payments] Additional payment recorded on won opportunity", {
      paymentId,
      opportunityId: args.opportunityId,
      attributedCloserId,
      origin,
      programId: program._id,
      paymentType,
    });

    return { paymentId, customerId: customer?._id };
  },
});
