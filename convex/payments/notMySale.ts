import { v } from "convex/values";
import { mutation } from "../_generated/server";
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
    await ctx.db.patch("providerPayments", payment._id, { notMySaleAt: now, notMySaleByUserId: userId });
    await emitDomainEvent(ctx, {
      tenantId, entityType: "payment", entityId: paymentRecordId,
      eventType: "payment.flagged_not_my_sale", source: "closer", actorUserId: userId,
      metadata: { providerPaymentId: payment._id, opportunityId: deal._id }, occurredAt: now,
    });
    return { ok: true as const, alreadyApplied: false };
  },
});

export const clearNotMySale = mutation({
  args: { providerPaymentId: v.id("providerPayments") },
  returns: resultValidator,
  handler: async (ctx, { providerPaymentId }) => {
    const { tenantId, userId } = await requireBillingPermission(ctx, "billing:review");
    await requireBillingOpsEnabled(ctx, tenantId);
    const payment = await ctx.db.get("providerPayments", providerPaymentId);
    if (payment?.tenantId !== tenantId) return refuse("stale_preview");
    if (payment.notMySaleAt === undefined) return { ok: true as const, alreadyApplied: true };
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
