import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { countBillingPayments } from "./aggregates";
import {
  enrichBillingPaymentDetail,
  enrichBillingPaymentListRows,
  enrichBillingPaymentRows,
} from "./enrichment";
import { normalizeExportLimit, toBillingExportRow } from "./export";
import {
  requireBillingOpsEnabled,
  requireBillingPermission,
} from "./guards";
import {
  paginateBillingPaymentQuery,
  takeBillingPaymentQuery,
} from "./queryBuilder";
import {
  billingQueueFiltersValidator,
  exportPaymentsArgsValidator,
  listPaymentsArgsValidator,
} from "./validators";

async function assertProgramFilterForTenant(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  programId: Id<"tenantPrograms"> | undefined,
) {
  if (!programId) {
    return;
  }
  const program = await ctx.db.get(programId);
  if (!program || program.tenantId !== tenantId) {
    throw new Error("Program not found.");
  }
}

export const getAvailability = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    const tenant = await ctx.db.get(tenantId);
    const enabled = tenant?.billingOpsEnabled === true;
    return {
      enabled,
      reason: enabled ? null : "Billing Ops is not enabled for this tenant.",
    };
  },
});

export const listPayments = query({
  args: listPaymentsArgsValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);

    const page = await paginateBillingPaymentQuery(
      ctx,
      tenantId,
      args,
      args.paginationOpts,
    );

    return {
      ...page,
      page: await enrichBillingPaymentListRows(ctx, tenantId, page.page),
      exactCount: await countBillingPayments(ctx, tenantId, args),
    };
  },
});

export const getPaymentCount = query({
  args: billingQueueFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    return await countBillingPayments(ctx, tenantId, args);
  },
});

export const getPaymentDetail = query({
  args: { paymentRecordId: v.id("paymentRecords") },
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);

    const payment = await ctx.db.get(paymentRecordId);
    if (!payment || payment.tenantId !== tenantId) {
      return null;
    }

    return await enrichBillingPaymentDetail(ctx, tenantId, payment);
  },
});

export const getNextPaymentForReview = query({
  args: { currentPaymentRecordId: v.optional(v.id("paymentRecords")) },
  handler: async (ctx, { currentPaymentRecordId }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);

    const current = currentPaymentRecordId
      ? await ctx.db.get(currentPaymentRecordId)
      : null;
    if (currentPaymentRecordId && (!current || current.tenantId !== tenantId)) {
      throw new Error("Payment not found.");
    }

    const afterCurrent = current
      ? await ctx.db
          .query("paymentRecords")
          .withIndex("by_tenantId_and_status_and_recordedAt", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("status", "recorded")
              .lt("recordedAt", current.recordedAt),
          )
          .order("desc")
          .first()
      : null;

    if (afterCurrent) {
      return { paymentRecordId: afterCurrent._id };
    }

    const oldest = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_recordedAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "recorded"),
      )
      .order("asc")
      .first();

    return { paymentRecordId: oldest?._id ?? null };
  },
});

export const exportPayments = query({
  args: exportPaymentsArgsValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:export");
    await requireBillingOpsEnabled(ctx, tenantId);
    await assertProgramFilterForTenant(ctx, tenantId, args.programId);

    const limit = normalizeExportLimit(args.limit);
    const exactCount = await countBillingPayments(ctx, tenantId, args);
    const payments = await takeBillingPaymentQuery(ctx, tenantId, args, limit);
    const rows = await enrichBillingPaymentRows(ctx, tenantId, payments);

    return {
      rows: rows.map(toBillingExportRow),
      exactCount,
      exportedCount: rows.length,
      truncated: exactCount > limit,
      limit,
    };
  },
});
