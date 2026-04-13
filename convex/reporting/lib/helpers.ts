import type { Value } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

const MAX_PAYMENT_SCAN_ROWS = 2500;

export type AttributedPayment = Doc<"paymentRecords"> & {
  effectiveCloserId: Id<"users"> | null;
};

export function getUserDisplayName(
  user: Pick<Doc<"users">, "email" | "fullName"> | null | undefined,
): string {
  const fullName = user?.fullName?.trim();
  return fullName && fullName.length > 0
    ? fullName
    : (user?.email ?? "Unknown");
}

/**
 * Fetch all active closers for a tenant, sorted for deterministic report rows.
 */
export async function getActiveClosers(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
) {
  const closers: Array<Doc<"users">> = [];

  for await (const user of ctx.db
    .query("users")
    .withIndex("by_tenantId_and_isActive", (q) =>
      q.eq("tenantId", tenantId).eq("isActive", true),
    )) {
    if (user.role === "closer") {
      closers.push(user);
    }
  }

  closers.sort((left, right) =>
    getUserDisplayName(left).localeCompare(getUserDisplayName(right), undefined, {
      sensitivity: "base",
    }),
  );

  return closers;
}

export function assertValidDateRange(startDate: number, endDate: number) {
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate)) {
    throw new Error("startDate and endDate must be finite numbers");
  }

  if (startDate >= endDate) {
    throw new Error("startDate must be earlier than endDate");
  }
}

/**
 * Create aggregate-compatible bounds for scalar time keys.
 */
export function makeDateBounds(startDate: number, endDate: number) {
  assertValidDateRange(startDate, endDate);
  return {
    lower: { key: startDate, inclusive: true as const },
    upper: { key: endDate, inclusive: false as const },
  };
}

/**
 * Create aggregate-compatible bounds for tuple keys that end in a timestamp.
 */
export function makeTupleDateBounds<TPrefix extends readonly Value[]>(
  prefix: TPrefix,
  startDate: number,
  endDate: number,
) {
  assertValidDateRange(startDate, endDate);
  return {
    lower: {
      key: [...prefix, startDate] as [...TPrefix, number],
      inclusive: true as const,
    },
    upper: {
      key: [...prefix, endDate] as [...TPrefix, number],
      inclusive: false as const,
    },
  };
}

/**
 * Payment rows are currently keyed by the recording user, which can be an admin.
 * For closer reports, attribute payments to the opportunity/customer owner instead.
 */
export async function attributePaymentsToClosers(
  ctx: QueryCtx,
  payments: Array<Doc<"paymentRecords">>,
): Promise<Array<AttributedPayment>> {
  if (payments.length === 0) {
    return [];
  }

  const opportunityIds = [
    ...new Set(
      payments
        .map((payment) => payment.opportunityId)
        .filter((opportunityId): opportunityId is Id<"opportunities"> =>
          opportunityId !== undefined,
        ),
    ),
  ];
  const customerIds = [
    ...new Set(
      payments
        .map((payment) => payment.customerId)
        .filter((customerId): customerId is Id<"customers"> => customerId !== undefined),
    ),
  ];

  const [opportunities, customers] = await Promise.all([
    Promise.all(
      opportunityIds.map(async (opportunityId) => [
        opportunityId,
        await ctx.db.get(opportunityId),
      ] as const),
    ),
    Promise.all(
      customerIds.map(async (customerId) => [
        customerId,
        await ctx.db.get(customerId),
      ] as const),
    ),
  ]);

  const opportunityById = new Map<
    Id<"opportunities">,
    Doc<"opportunities"> | null
  >(opportunities);
  const customerById = new Map<Id<"customers">, Doc<"customers"> | null>(
    customers,
  );

  return payments.map((payment) => {
    if (payment.contextType === "opportunity" && payment.opportunityId) {
      const effectiveCloserId =
        opportunityById.get(payment.opportunityId)?.assignedCloserId ??
        payment.closerId;
      return { ...payment, effectiveCloserId: effectiveCloserId ?? null };
    }

    if (payment.contextType === "customer" && payment.customerId) {
      const effectiveCloserId =
        customerById.get(payment.customerId)?.convertedByUserId ??
        payment.closerId;
      return { ...payment, effectiveCloserId: effectiveCloserId ?? null };
    }

    return { ...payment, effectiveCloserId: payment.closerId ?? null };
  });
}

export async function getNonDisputedPaymentsInRange(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  startDate: number,
  endDate: number,
): Promise<{
  isTruncated: boolean;
  payments: Array<Doc<"paymentRecords">>;
}> {
  assertValidDateRange(startDate, endDate);

  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_recordedAt", (q) =>
      q.eq("tenantId", tenantId).gte("recordedAt", startDate).lt("recordedAt", endDate),
    )
    .take(MAX_PAYMENT_SCAN_ROWS + 1);

  return {
    isTruncated: payments.length > MAX_PAYMENT_SCAN_ROWS,
    payments: payments
      .slice(0, MAX_PAYMENT_SCAN_ROWS)
      .filter((payment) => payment.status !== "disputed"),
  };
}

export function summarizeAttributedPayments(
  payments: Array<AttributedPayment>,
): {
  byCloser: Map<Id<"users">, { dealCount: number; revenueMinor: number }>;
  totalDealCount: number;
  totalRevenueMinor: number;
} {
  const byCloser = new Map<
    Id<"users">,
    { dealCount: number; revenueMinor: number }
  >();
  let totalDealCount = 0;
  let totalRevenueMinor = 0;

  for (const payment of payments) {
    totalDealCount += 1;
    totalRevenueMinor += payment.amountMinor;

    if (!payment.effectiveCloserId) {
      continue;
    }

    const existing = byCloser.get(payment.effectiveCloserId) ?? {
      dealCount: 0,
      revenueMinor: 0,
    };
    existing.dealCount += 1;
    existing.revenueMinor += payment.amountMinor;
    byCloser.set(payment.effectiveCloserId, existing);
  }

  return {
    byCloser,
    totalDealCount,
    totalRevenueMinor,
  };
}
