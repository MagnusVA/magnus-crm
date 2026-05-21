import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import {
  paymentTypeValidator,
  resolveLegacyCompatiblePaymentCommissionable,
  resolvePaymentType,
} from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getNonDisputedPaymentsInRange,
} from "./lib/helpers";

const REVENUE_SLICE_FILTER = v.union(
  v.literal("commissionable"),
  v.literal("non_commissionable"),
);
const MAX_MATRIX_PAYMENTS = 500;

type ProgramBucket = Id<"tenantPrograms"> | "unknown";
type MatrixKey = string;

export const getBookedVsSoldMatrix = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    paymentProgramId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(paymentTypeValidator),
    revenueSlice: v.optional(REVENUE_SLICE_FILTER),
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
    const filteredPayments = paymentScan.payments.filter(
      (payment) =>
        (!args.paymentProgramId ||
          payment.programId === args.paymentProgramId) &&
        (!args.paymentType ||
          resolvePaymentType(payment.paymentType) === args.paymentType) &&
        (!args.revenueSlice ||
          (args.revenueSlice === "commissionable") ===
            resolveLegacyCompatiblePaymentCommissionable(payment)),
    );

    const matrixPayments = filteredPayments.slice(0, MAX_MATRIX_PAYMENTS);
    const opportunityIds = [
      ...new Set(
        matrixPayments
          .map((payment) => payment.originatingOpportunityId ?? payment.opportunityId)
          .filter((id): id is Id<"opportunities"> => id !== undefined),
      ),
    ];
    const opportunities = await Promise.all(
      opportunityIds.map(async (opportunityId) => ctx.db.get(opportunityId)),
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
      const opportunityId =
        payment.originatingOpportunityId ?? payment.opportunityId;
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
      [...programIds].map(async (programId) => ctx.db.get(programId)),
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
  },
});
