import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireBillingOpsEnabled, requireBillingPermission } from "../billing/guards";
import { emitDomainEvent } from "../lib/domainEvents";
import { expectedError } from "../lib/observability/errors";
import { resolveLegacyCompatibleAttributedCloserId } from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import { readActiveAllocation } from "./allocation";
import { paymentCommandRefusalValidator, refuse } from "./commandResult";

const resultValidator = v.union(
  paymentCommandRefusalValidator,
  v.object({ ok: v.literal(true), alreadyApplied: v.boolean() }),
);

export const flagNotMySale = mutation({
  args: { paymentRecordId: v.id("paymentRecords") },
  returns: resultValidator,
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);
    const record = await ctx.db.get("paymentRecords", paymentRecordId);
    if (record?.tenantId !== tenantId || !record.providerPaymentId || !record.opportunityId) return refuse("stale_preview");
    const [payment, deal] = await Promise.all([
      ctx.db.get("providerPayments", record.providerPaymentId),
      ctx.db.get("opportunities", record.opportunityId),
    ]);
    if (payment?.tenantId !== tenantId || deal?.tenantId !== tenantId) return refuse("stale_preview");
    if (userId !== deal.assignedCloserId && userId !== resolveLegacyCompatibleAttributedCloserId(record)) {
      throw expectedError("auth.not_your_payment", "This payment is assigned to another closer.");
    }
    if ((await readActiveAllocation(ctx, payment))?._id !== paymentRecordId) return refuse("reallocated");
    if (payment.notMySaleAt !== undefined) return { ok: true as const, alreadyApplied: true };
    const now = Date.now();
    await ctx.db.patch("providerPayments", payment._id, {
      notMySaleAt: now,
      notMySaleByUserId: userId,
      notMySaleGeneration: (payment.notMySaleGeneration ?? 0) + 1,
    });
    await emitDomainEvent(ctx, {
      tenantId, entityType: "payment", entityId: paymentRecordId,
      eventType: "payment.flagged_not_my_sale", source: "closer", actorUserId: userId,
      metadata: { providerPaymentId: payment._id, opportunityId: deal._id }, occurredAt: now,
    });
    return { ok: true as const, alreadyApplied: false };
  },
});

const clearPins = {
  expectedFlagGeneration: v.number(),
  expectedAllocationRevision: v.number(),
};

export const getClearNotMySalePin = query({
  args: { providerPaymentId: v.id("providerPayments") },
  returns: v.union(v.null(), v.object({
    ...clearPins,
    flaggedAt: v.number(),
    paymentRecordId: v.union(v.id("paymentRecords"), v.null()),
  })),
  handler: async (ctx, { providerPaymentId }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:review");
    await requireBillingOpsEnabled(ctx, tenantId);
    const payment = await ctx.db.get("providerPayments", providerPaymentId);
    if (payment?.tenantId !== tenantId || payment.notMySaleAt === undefined) return null;
    return {
      expectedFlagGeneration: payment.notMySaleGeneration ?? 0,
      expectedAllocationRevision: payment.allocationRevision,
      flaggedAt: payment.notMySaleAt,
      paymentRecordId: payment.paymentRecordId ?? null,
    };
  },
});

export const clearNotMySale = mutation({
  args: { providerPaymentId: v.id("providerPayments"), ...clearPins },
  returns: resultValidator,
  handler: async (ctx, { providerPaymentId, expectedFlagGeneration, expectedAllocationRevision }) => {
    const { tenantId, userId } = await requireBillingPermission(ctx, "billing:review");
    await requireBillingOpsEnabled(ctx, tenantId);
    const payment = await ctx.db.get("providerPayments", providerPaymentId);
    if (payment?.tenantId !== tenantId || (payment.notMySaleGeneration ?? 0) !== expectedFlagGeneration) {
      return refuse("stale_preview");
    }
    if (payment.notMySaleAt === undefined) return { ok: true as const, alreadyApplied: true };
    if (payment.allocationRevision !== expectedAllocationRevision) return refuse("reallocated");
    const record = (await readActiveAllocation(ctx, payment)) ??
      (await ctx.db.query("paymentRecords").withIndex("by_tenantId_and_providerPaymentId", (q) =>
        q.eq("tenantId", tenantId).eq("providerPaymentId", providerPaymentId)).order("desc").first());
    if (!record) return refuse("reallocated");
    const now = Date.now();
    await ctx.db.patch("providerPayments", providerPaymentId, { notMySaleAt: undefined, notMySaleByUserId: undefined });
    await emitDomainEvent(ctx, {
      tenantId, entityType: "payment", entityId: record._id,
      eventType: "payment.not_my_sale_cleared", source: "admin", actorUserId: userId,
      metadata: { providerPaymentId, opportunityId: record.opportunityId }, occurredAt: now,
    });
    return { ok: true as const, alreadyApplied: false };
  },
});
