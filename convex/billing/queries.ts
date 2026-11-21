import { buildPaymentDetail } from "./queriesCore";
import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { paymentProviderTables } from "../payments/schema";
import { countBillingPayments } from "./aggregates";
import {
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
  const program = await ctx.db.get("tenantPrograms", programId);
  if (!program || program.tenantId !== tenantId) {
    throw new Error("Program not found.");
  }
}

export const getAvailability = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    const tenant = await ctx.db.get("tenants", tenantId);
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

    return await buildPaymentDetail(ctx, tenantId, paymentRecordId);
  },
});

const correctionFields = paymentProviderTables.paymentCorrections.validator.fields;

export const getPaymentCorrections = query({
  args: { paymentRecordId: v.id("paymentRecords") },
  returns: v.object({
    corrections: v.array(v.object({
      correctionId: v.id("paymentCorrections"),
      operation: correctionFields.operation,
      result: correctionFields.result,
      cause: correctionFields.cause,
      level: correctionFields.level,
      createdAt: correctionFields.createdAt,
      actorName: v.union(v.string(), v.null()),
      restoredByCorrectionId: correctionFields.restoredByCorrectionId,
    })),
    restorable: v.union(v.id("paymentCorrections"), v.null()),
  }),
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const payment = await ctx.db.get("paymentRecords", paymentRecordId);
    if (payment?.tenantId !== tenantId) return { corrections: [], restorable: null };

    const rows = await ctx.db.query("paymentCorrections")
      .withIndex("by_tenantId_and_paymentRecordId_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("paymentRecordId", paymentRecordId))
      .order("desc").take(10);
    const restorable = rows.find((row) => row.operation === "exclude" && row.restoredByCorrectionId === undefined);
    const actorIds = [...new Set(rows.map((row) => row.actorUserId))];
    const actorNames = new Map(await Promise.all(actorIds.map(async (id) => {
      const actor = await ctx.db.get("users", id);
      return [id, actor?.tenantId === tenantId ? actor.fullName ?? actor.calendlyMemberName ?? null : null] as const;
    })));
    return {
      corrections: rows.map((row) => ({
        correctionId: row._id,
        operation: row.operation,
        result: row.result,
        cause: row.cause,
        level: row.level,
        createdAt: row.createdAt,
        actorName: actorNames.get(row.actorUserId) ?? null,
        restoredByCorrectionId: row.restoredByCorrectionId,
      })),
      restorable: restorable?._id ?? null,
    };
  },
});

export const getNextPaymentForReview = query({
  args: { currentPaymentRecordId: v.optional(v.id("paymentRecords")) },
  handler: async (ctx, { currentPaymentRecordId }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);

    const current = currentPaymentRecordId
      ? await ctx.db.get("paymentRecords", currentPaymentRecordId)
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
