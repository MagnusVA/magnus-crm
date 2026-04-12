import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { executeConversion } from "../customers/conversion";

/**
 * Generate a file upload URL for payment proof.
 *
 * Returns a short-lived URL that the client uses to upload a file
 * to Convex file storage. The resulting storage ID is then passed
 * to logPayment as proofFileId.
 *
 * Accessible by closers and admins.
 */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    console.log("[Closer:Payment] generateUploadUrl called");
    await requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"]);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Log a payment for an opportunity.
 *
 * Creates a paymentRecords entry and transitions the opportunity
 * to "payment_received" (terminal state).
 *
 * The payment proof file (if any) must already be uploaded to Convex
 * file storage via generateUploadUrl — pass the resulting storage ID
 * as proofFileId.
 *
 * Only closers can log payments on their own opportunities.
 * Admins can log payments on any opportunity.
 */
export const logPayment = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
    amount: v.number(),
    currency: v.string(),
    provider: v.string(),
    referenceCode: v.optional(v.string()),
    proofFileId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    console.log("[Closer:Payment] logPayment called", {
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      amount: args.amount,
      currency: args.currency,
      provider: args.provider,
      hasProofFile: !!args.proofFileId,
    });
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    // Load and validate the opportunity
    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    // Closer authorization: only own opportunities
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }

    // Validate the meeting belongs to this opportunity
    const meeting = await ctx.db.get(args.meetingId);
    console.log("[Closer:Payment] logPayment validation", {
      opportunityFound: !!opportunity,
      meetingFound: !!meeting,
      meetingBelongsToOpp: meeting?.opportunityId === args.opportunityId,
      currentStatus: opportunity?.status,
    });
    if (
      !meeting ||
      meeting.tenantId !== tenantId ||
      meeting.opportunityId !== args.opportunityId
    ) {
      throw new Error("Meeting does not belong to this opportunity");
    }

    // Validate status transition
    if (!validateTransition(opportunity.status, "payment_received")) {
      throw new Error(
        `Cannot log payment for opportunity with status "${opportunity.status}". ` +
          `Only "in_progress" opportunities can receive payments.`
      );
    }

    // Validate amount
    if (args.amount <= 0) {
      throw new Error("Payment amount must be positive");
    }

    const currency = args.currency.trim().toUpperCase();
    if (!currency) {
      throw new Error("Currency is required");
    }

    const provider = args.provider.trim();
    if (!provider) {
      throw new Error("Provider is required");
    }

    const referenceCode = args.referenceCode?.trim();

    // Create payment record
    const paymentId = await ctx.db.insert("paymentRecords", {
      tenantId,
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      closerId: userId,
      amount: args.amount,
      currency,
      provider,
      referenceCode: referenceCode || undefined,
      proofFileId: args.proofFileId ?? undefined,
      status: "recorded",
      recordedAt: Date.now(),
    });

    console.log("[Closer:Payment] payment record created", { paymentId });

    // Transition opportunity to payment_received (terminal state)
    await ctx.db.patch(args.opportunityId, {
      status: "payment_received",
      updatedAt: Date.now(),
    });

    console.log("[Closer:Payment] opportunity transitioned to payment_received", { opportunityId: args.opportunityId });

    // === Feature D: Auto-conversion ===
    // After payment_received, auto-convert the lead to a customer.
    const customerId = await executeConversion(ctx, {
      tenantId,
      leadId: opportunity.leadId,
      convertedByUserId: userId,
      winningOpportunityId: args.opportunityId,
      winningMeetingId: args.meetingId,
    });

    if (customerId) {
      // Set customerId on the payment record we just created
      await ctx.db.patch(paymentId, { customerId });
      console.log("[Closer:Payment] Auto-conversion complete", {
        paymentId,
        customerId,
      });
    } else {
      // Customer already exists — this is a returning customer / additional sale
      // Find the existing customer and link this payment
      const existingCustomer = await ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
        )
        .first();
      if (existingCustomer) {
        await ctx.db.patch(paymentId, {
          customerId: existingCustomer._id,
        });
        console.log("[Closer:Payment] Payment linked to existing customer", {
          paymentId,
          customerId: existingCustomer._id,
        });
      }
    }
    // === End Feature D ===

    return paymentId;
  },
});

/**
 * Get a tenant-scoped URL for a payment proof file.
 *
 * Validates that the caller belongs to the same tenant as the
 * payment record before generating the file URL.
 *
 * Returns null if the record doesn't exist, has no proof file,
 * or the caller isn't authorized.
 */
export const getPaymentProofUrl = query({
  args: { paymentRecordId: v.id("paymentRecords") },
  handler: async (ctx, { paymentRecordId }) => {
    console.log("[Closer:Payment] getPaymentProofUrl called", { paymentRecordId });
    const { tenantId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const record = await ctx.db.get(paymentRecordId);
    if (!record || record.tenantId !== tenantId || !record.proofFileId) {
      console.log("[Closer:Payment] getPaymentProofUrl: not found or no proof", { found: !!record, hasProofFile: !!record?.proofFileId });
      return null;
    }

    console.log("[Closer:Payment] getPaymentProofUrl: returning URL", { paymentRecordId });
    return await ctx.storage.getUrl(record.proofFileId);
  },
});
