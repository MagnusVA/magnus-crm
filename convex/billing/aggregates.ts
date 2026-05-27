import { TableAggregate } from "@convex-dev/aggregate";
import { components } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertBillingDateRange } from "./queryBuilder";
import type { BillingCountArgs } from "./types";

type PaymentStatus = Doc<"paymentRecords">["status"];
type PaymentType = Doc<"paymentRecords">["paymentType"];

const OPEN_START = Number.NEGATIVE_INFINITY;
const OPEN_END = Number.POSITIVE_INFINITY;

export const billingPaymentsByStatus = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [PaymentStatus, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.billingPaymentsByStatus, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.status, doc.recordedAt],
});

export const billingPaymentsByStatusProgram = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [PaymentStatus, Id<"tenantPrograms">, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.billingPaymentsByStatusProgram, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.status, doc.programId, doc.recordedAt],
});

export const billingPaymentsByStatusType = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [PaymentStatus, PaymentType, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.billingPaymentsByStatusType, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.status, doc.paymentType, doc.recordedAt],
});

export const billingPaymentsByStatusProgramType = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [PaymentStatus, Id<"tenantPrograms">, PaymentType, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.billingPaymentsByStatusProgramType, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [
    doc.status,
    doc.programId,
    doc.paymentType,
    doc.recordedAt,
  ],
});

export async function insertBillingPaymentAggregates(
  ctx: MutationCtx,
  payment: Doc<"paymentRecords">,
) {
  await Promise.all([
    billingPaymentsByStatus.insertIfDoesNotExist(ctx, payment),
    billingPaymentsByStatusProgram.insertIfDoesNotExist(ctx, payment),
    billingPaymentsByStatusType.insertIfDoesNotExist(ctx, payment),
    billingPaymentsByStatusProgramType.insertIfDoesNotExist(ctx, payment),
  ]);
}

export async function replaceBillingPaymentAggregates(
  ctx: MutationCtx,
  before: Doc<"paymentRecords">,
  after: Doc<"paymentRecords">,
) {
  await Promise.all([
    billingPaymentsByStatus.replaceOrInsert(ctx, before, after),
    billingPaymentsByStatusProgram.replaceOrInsert(ctx, before, after),
    billingPaymentsByStatusType.replaceOrInsert(ctx, before, after),
    billingPaymentsByStatusProgramType.replaceOrInsert(ctx, before, after),
  ]);
}

export async function deleteBillingPaymentAggregates(
  ctx: MutationCtx,
  payment: Doc<"paymentRecords">,
) {
  await Promise.all([
    billingPaymentsByStatus.deleteIfExists(ctx, payment),
    billingPaymentsByStatusProgram.deleteIfExists(ctx, payment),
    billingPaymentsByStatusType.deleteIfExists(ctx, payment),
    billingPaymentsByStatusProgramType.deleteIfExists(ctx, payment),
  ]);
}

export async function clearBillingPaymentAggregatesForTenant(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
) {
  await Promise.all([
    billingPaymentsByStatus.clear(ctx, { namespace: tenantId }),
    billingPaymentsByStatusProgram.clear(ctx, { namespace: tenantId }),
    billingPaymentsByStatusType.clear(ctx, { namespace: tenantId }),
    billingPaymentsByStatusProgramType.clear(ctx, { namespace: tenantId }),
  ]);
}

export async function countBillingPayments(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  args: BillingCountArgs,
) {
  assertBillingDateRange(args);

  const startAt = args.startAt ?? OPEN_START;
  const endAt = args.endAt ?? OPEN_END;
  const hasDateBounds = args.startAt !== undefined || args.endAt !== undefined;

  if (args.programId && args.paymentType) {
    return await billingPaymentsByStatusProgramType.count(ctx, {
      namespace: tenantId,
      bounds: hasDateBounds
        ? {
            lower: {
              key: [args.status, args.programId, args.paymentType, startAt],
              inclusive: true,
            },
            upper: {
              key: [args.status, args.programId, args.paymentType, endAt],
              inclusive: false,
            },
          }
        : { prefix: [args.status, args.programId, args.paymentType] },
    });
  }

  if (args.programId) {
    return await billingPaymentsByStatusProgram.count(ctx, {
      namespace: tenantId,
      bounds: hasDateBounds
        ? {
            lower: {
              key: [args.status, args.programId, startAt],
              inclusive: true,
            },
            upper: {
              key: [args.status, args.programId, endAt],
              inclusive: false,
            },
          }
        : { prefix: [args.status, args.programId] },
    });
  }

  if (args.paymentType) {
    return await billingPaymentsByStatusType.count(ctx, {
      namespace: tenantId,
      bounds: hasDateBounds
        ? {
            lower: {
              key: [args.status, args.paymentType, startAt],
              inclusive: true,
            },
            upper: {
              key: [args.status, args.paymentType, endAt],
              inclusive: false,
            },
          }
        : { prefix: [args.status, args.paymentType] },
    });
  }

  return await billingPaymentsByStatus.count(ctx, {
    namespace: tenantId,
    bounds: hasDateBounds
      ? {
          lower: {
            key: [args.status, startAt],
            inclusive: true,
          },
          upper: {
            key: [args.status, endAt],
            inclusive: false,
          },
        }
      : { prefix: [args.status] },
  });
}
