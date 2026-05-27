import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor } from "../lib/formatMoney";
import {
  requireActiveProgram,
  syncCustomerPaymentSummary,
} from "../lib/paymentHelpers";
import { refreshSoldProgramCachesForPaymentContext } from "../lib/soldProgramCache";
import { replaceTenantPaymentStatsForCorrection } from "../lib/tenantStatsHelper";
import { replacePaymentAggregate } from "../reporting/writeHooks";
import { countBillingPayments, replaceBillingPaymentAggregates } from "./aggregates";
import {
  normalizeExportFilters,
  normalizeExportLimit,
} from "./export";
import {
  requireBillingOpsEnabled,
  requireBillingPermission,
} from "./guards";
import {
  correctPaymentArgsValidator,
  correctPaymentReturnValidator,
  exportPaymentsArgsValidator,
} from "./validators";

type PaymentPatch = Partial<Omit<Doc<"paymentRecords">, "_id" | "_creationTime">>;
type PaymentKey = keyof Doc<"paymentRecords">;

const FINANCIAL_CORRECTION_KEYS = new Set<PaymentKey>([
  "amountMinor",
  "paymentType",
  "programId",
  "programName",
]);

const TENANT_STATS_CORRECTION_KEYS = new Set<PaymentKey>([
  "amountMinor",
  "paymentType",
]);

function addChangedKey(changedKeys: PaymentKey[], key: PaymentKey) {
  if (!changedKeys.includes(key)) {
    changedKeys.push(key);
  }
}

function hasChangedKey(changedKeys: PaymentKey[], keys: Set<PaymentKey>) {
  return changedKeys.some((key) => keys.has(key));
}

function buildCorrectionMetadata(
  before: Doc<"paymentRecords">,
  after: Doc<"paymentRecords">,
  changedKeys: PaymentKey[],
  options: { returnedToReview: boolean },
) {
  const changed: Record<string, unknown> = {};
  for (const key of changedKeys) {
    changed[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  changed.returnedToReview = options.returnedToReview;
  return changed;
}

function clampExportedCount(exportedCount: number, limit: number) {
  const parsed = Math.trunc(exportedCount);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(parsed, limit));
}

async function refreshPaymentCorrectionSideEffects(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    before: Doc<"paymentRecords">;
    paymentRecordId: Id<"paymentRecords">;
    changedKeys: PaymentKey[];
  },
) {
  const after = await replacePaymentAggregate(
    ctx,
    args.before,
    args.paymentRecordId,
  );

  if (hasChangedKey(args.changedKeys, TENANT_STATS_CORRECTION_KEYS)) {
    await replaceTenantPaymentStatsForCorrection(ctx, args.tenantId, {
      before: args.before,
      after,
    });
  }

  if (hasChangedKey(args.changedKeys, FINANCIAL_CORRECTION_KEYS) && after.customerId) {
    await syncCustomerPaymentSummary(ctx, after.customerId);
  }

  if (args.changedKeys.includes("programId")) {
    await refreshSoldProgramCachesForPaymentContext(ctx, {
      tenantId: args.tenantId,
      payment: after,
    });
  }

  return after;
}

export const markReviewed = mutation({
  args: { paymentRecordId: v.id("paymentRecords") },
  returns: v.null(),
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId, userId } = await requireBillingPermission(
      ctx,
      "billing:review",
    );
    await requireBillingOpsEnabled(ctx, tenantId);

    const payment = await ctx.db.get(paymentRecordId);
    if (!payment || payment.tenantId !== tenantId) {
      throw new Error("Payment not found.");
    }
    if (payment.status === "disputed") {
      throw new Error("Disputed payments cannot be marked reviewed.");
    }
    if (payment.status === "verified") {
      return null;
    }

    const now = Date.now();
    const reviewPatch = {
      status: "verified" as const,
      verifiedAt: now,
      verifiedByUserId: userId,
      statusChangedAt: now,
    };
    const reviewedPayment = { ...payment, ...reviewPatch };

    await ctx.db.patch(paymentRecordId, reviewPatch);
    await replaceBillingPaymentAggregates(ctx, payment, reviewedPayment);

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentRecordId,
      eventType: "payment.verified",
      source: "admin",
      actorUserId: userId,
      fromStatus: payment.status,
      toStatus: "verified",
      occurredAt: now,
      metadata: {
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        paymentType: payment.paymentType,
        programId: payment.programId,
        programName: payment.programName,
      },
    });

    return null;
  },
});

export const correctPayment = mutation({
  args: correctPaymentArgsValidator,
  returns: correctPaymentReturnValidator,
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireBillingPermission(
      ctx,
      "billing:correct",
    );
    await requireBillingOpsEnabled(ctx, tenantId);

    const payment = await ctx.db.get(args.paymentRecordId);
    if (!payment || payment.tenantId !== tenantId) {
      throw new Error("Payment not found.");
    }
    if (payment.status === "disputed") {
      throw new Error("Disputed payments must be repaired through a dispute flow.");
    }

    const reason = args.reason.trim();
    if (!reason) {
      throw new Error("A correction reason is required.");
    }

    const patch: PaymentPatch = {};
    const changedKeys: PaymentKey[] = [];

    if (args.amount !== undefined) {
      const amountMinor = toAmountMinor(args.amount);
      if (amountMinor !== payment.amountMinor) {
        patch.amountMinor = amountMinor;
        addChangedKey(changedKeys, "amountMinor");
      }
    }

    if (
      args.paymentType !== undefined &&
      args.paymentType !== payment.paymentType
    ) {
      patch.paymentType = args.paymentType;
      addChangedKey(changedKeys, "paymentType");
    }

    if (args.programId !== undefined && args.programId !== payment.programId) {
      const program = await requireActiveProgram(ctx, tenantId, args.programId);
      patch.programId = program._id;
      patch.programName = program.name;
      addChangedKey(changedKeys, "programId");
      addChangedKey(changedKeys, "programName");
    }

    if (args.referenceCode !== undefined) {
      const nextReferenceCode = args.referenceCode.trim() || undefined;
      if (nextReferenceCode !== payment.referenceCode) {
        patch.referenceCode = nextReferenceCode;
        addChangedKey(changedKeys, "referenceCode");
      }
    }

    if (args.note !== undefined) {
      const nextNote = args.note.trim() || undefined;
      if (nextNote !== payment.note) {
        patch.note = nextNote;
        addChangedKey(changedKeys, "note");
      }
    }

    if (changedKeys.length === 0) {
      return {
        paymentRecordId: args.paymentRecordId,
        status: payment.status,
        returnedToReview: false,
        changed: false,
      };
    }

    const financialChange = hasChangedKey(
      changedKeys,
      FINANCIAL_CORRECTION_KEYS,
    );
    const now = Date.now();
    const returnedToReview = financialChange && payment.status === "verified";
    if (returnedToReview) {
      patch.status = "recorded";
      patch.verifiedAt = undefined;
      patch.verifiedByUserId = undefined;
      patch.statusChangedAt = now;
    }

    await ctx.db.patch(args.paymentRecordId, patch);
    const nextPayment = await refreshPaymentCorrectionSideEffects(ctx, {
      tenantId,
      before: payment,
      paymentRecordId: args.paymentRecordId,
      changedKeys,
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: args.paymentRecordId,
      eventType: "payment.corrected",
      source: "admin",
      actorUserId: userId,
      fromStatus: payment.status,
      toStatus: nextPayment.status,
      reason,
      occurredAt: now,
      metadata: buildCorrectionMetadata(payment, nextPayment, changedKeys, {
        returnedToReview,
      }),
    });

    return {
      paymentRecordId: args.paymentRecordId,
      status: nextPayment.status,
      returnedToReview,
      changed: true,
    };
  },
});

export const recordExportAudit = mutation({
  args: {
    ...exportPaymentsArgsValidator,
    exportedCount: v.number(),
    truncated: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireBillingPermission(
      ctx,
      "billing:export",
    );
    await requireBillingOpsEnabled(ctx, tenantId);

    const program = args.programId ? await ctx.db.get(args.programId) : null;
    if (args.programId && (!program || program.tenantId !== tenantId)) {
      throw new Error("Program not found.");
    }

    const limit = normalizeExportLimit(args.limit);
    const filters = {
      status: args.status,
      programId: args.programId,
      paymentType: args.paymentType,
      startAt: args.startAt,
      endAt: args.endAt,
    };
    const exactCount = await countBillingPayments(ctx, tenantId, filters);
    const exportedCount = Math.min(
      clampExportedCount(args.exportedCount, limit),
      exactCount,
    );
    const truncated = exactCount > limit;

    return await ctx.db.insert("billingExportEvents", {
      tenantId,
      actorUserId: userId,
      filtersJson: normalizeExportFilters({
        ...filters,
        programName: program?.name,
        limit,
      }),
      exactCount,
      exportedCount,
      truncated,
      createdAt: Date.now(),
    });
  },
});
