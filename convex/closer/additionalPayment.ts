import { v } from "convex/values";
import { mutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  earliestCountingPayment,
  readDealPayments,
  syncPersonEnrollments,
} from "../lib/enrollments";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { recordPayment } from "../lib/leadLifecycle";
import {
  assertPaymentRow,
  type CommissionableOrigin,
} from "../lib/paymentHelpers";
import { paymentTypeValidator, resolvePaymentType } from "../lib/paymentTypes";
import { describeDealState, isWonDeal } from "../opportunities/dealGuards";
import { requireTenantUser } from "../requireTenantUser";
import { insertPaymentAggregate } from "../reporting/writeHooks";

/**
 * Records an ADDITIONAL commissionable payment against an already-won
 * opportunity (Closed won), for the case where a customer
 * makes a further payment after the initial win. Unlike every other payment
 * path, this does NOT transition the opportunity status (the deal is already
 * won / terminal). The person is already a customer, so the enrollment sync
 * only adds the payment to their total.
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
  }),
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const isAdmin = role === "tenant_master" || role === "tenant_admin";

    const opportunity = await ctx.db.get("opportunities", args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found.");
    }

    // Gate: additional payments are only for opportunities that are already won.
    if (!isWonDeal(opportunity)) {
      throw new Error(
        `Additional payments can only be added to a won deal. This deal is "${describeDealState(opportunity)}".`,
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
    // legitimate follow-on payments on an already-won deal. A deal won
    // before the sold program cache existed has none (10 in production), so
    // its earliest payment that isn't disputed names the program instead
    // (docs/plans/phase-4-customers.md D14).
    const programId =
      opportunity.soldProgramId ??
      earliestCountingPayment(await readDealPayments(ctx, opportunity._id))?.programId;
    if (!programId) {
      throw new Error(
        "This opportunity has no sold program or payment to take the program from.",
      );
    }
    const program = await ctx.db.get("tenantPrograms", programId);
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
      opportunityId: args.opportunityId,
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
      origin,
    });
    await recordPayment(ctx, paymentId);

    await insertPaymentAggregate(ctx, paymentId);

    // The person's enrollments follow their payments (§4.1). A payment for a
    // program the person already has creates no enrollment, and the sync
    // rebuilds the search row, whose total includes it. We deliberately do
    // NOT touch the opportunity status or sold-program cache.
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
        programName: program.name,
        paymentType,
        origin,
        commissionable: true,
        attributedCloserId,
        recordedByUserId: userId,
        additionalPayment: true,
        hasProofFile: Boolean(args.proofFileId),
        hasFathomLink: Boolean(fathomLink),
        noteProvided: Boolean(normalizedNote),
      },
    });

    return { paymentId };
  },
});
