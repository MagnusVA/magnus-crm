import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  paymentTypeValidator,
  resolvePaymentType,
  type PaymentType,
} from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import type { PaymentScan } from "./revenue";
import {
  assertValidDateRange,
  getNonDisputedPaymentsInRange,
} from "./lib/helpers";

const MAX_MATRIX_PAYMENTS = 500;

type ProgramBucket = Id<"tenantPrograms"> | "unknown";
type MatrixKey = string;

export type BookedVsSoldFilters = {
  paymentProgramId?: Id<"tenantPrograms"> | null;
  paymentType?: PaymentType | null;
};

/**
 * Booked program against sold program for a range's non-disputed payments.
 * Shared by the Convex reader and the ClickHouse report
 * (convex/analytics/definitions/revenue.ts).
 */
export async function buildBookedVsSoldMatrix(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  args: BookedVsSoldFilters,
  paymentScan: PaymentScan,
) {
  const filteredPayments = paymentScan.payments.filter(
    (payment) =>
      (!args.paymentProgramId ||
        payment.programId === args.paymentProgramId) &&
      (!args.paymentType ||
        resolvePaymentType(payment.paymentType) === args.paymentType),
  );

  const matrixPayments = filteredPayments.slice(0, MAX_MATRIX_PAYMENTS);
  const opportunityIds = [
    ...new Set(
      matrixPayments
        .map((payment) => payment.opportunityId)
        .filter((id): id is Id<"opportunities"> => id !== undefined),
    ),
  ];
  const opportunities = await Promise.all(
    opportunityIds.map(async (opportunityId) => ctx.db.get("opportunities", opportunityId)),
  );
  const opportunityById = new Map(
    opportunities
      .filter((opportunity) => opportunity?.tenantId === tenantId)
      .map((opportunity) => [opportunity!._id, opportunity!]),
  );

  const buckets = new Map<
    MatrixKey,
    {
      bookingProgramId: ProgramBucket;
      soldProgramId: ProgramBucket;
      paymentCount: number;
      totalAmountMinor: number;
    }
  >();

  for (const payment of matrixPayments) {
    // Every payment is a deal payment (docs/plans/phase-4-customers.md D12).
    const opportunityId = payment.opportunityId;
    const opportunity = opportunityId ? opportunityById.get(opportunityId) : null;
    const bookingProgramId =
      opportunity?.firstBookingProgramId ?? "unknown";
    const soldProgramId = payment.programId ?? "unknown";
    const key: MatrixKey = `${bookingProgramId}:${soldProgramId}`;
    const current = buckets.get(key) ?? {
      bookingProgramId,
      soldProgramId,
      paymentCount: 0,
      totalAmountMinor: 0,
    };

    current.paymentCount += 1;
    current.totalAmountMinor += payment.amountMinor;
    buckets.set(key, current);
  }

  const programIds = new Set<Id<"tenantPrograms">>();
  for (const bucket of buckets.values()) {
    if (bucket.bookingProgramId !== "unknown") {
      programIds.add(bucket.bookingProgramId);
    }
    if (bucket.soldProgramId !== "unknown") {
      programIds.add(bucket.soldProgramId);
    }
  }

  const programs = await Promise.all(
    [...programIds].map(async (programId) => ctx.db.get("tenantPrograms", programId)),
  );
  const programNameById = new Map<Id<"tenantPrograms">, string>();
  for (const program of programs) {
    if (program?.tenantId === tenantId) {
      programNameById.set(program._id, program.name);
    }
  }

  return {
    rows: [...buckets.values()]
      .map((bucket) => ({
        ...bucket,
        bookingProgramName:
          bucket.bookingProgramId === "unknown"
            ? "Unknown booked program"
            : programNameById.get(bucket.bookingProgramId) ??
              "Unknown booked program",
        soldProgramName:
          bucket.soldProgramId === "unknown"
            ? "Unknown sold program"
            : programNameById.get(bucket.soldProgramId) ??
              "Unknown sold program",
      }))
      .sort((left, right) => right.totalAmountMinor - left.totalAmountMinor),
    truncated:
      paymentScan.isTruncated || filteredPayments.length > MAX_MATRIX_PAYMENTS,
  };
}

export const getBookedVsSoldMatrix = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    paymentProgramId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(paymentTypeValidator),
  },
  handler: async (ctx, args) => {
    assertValidDateRange(args.startDate, args.endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const paymentScan = await getNonDisputedPaymentsInRange(
      ctx,
      tenantId,
      args.startDate,
      args.endDate,
    );
    return await buildBookedVsSoldMatrix(ctx, tenantId, args, paymentScan);
  },
});
