import type { Value } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  COMMISSIONABLE_ORIGINS,
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatiblePaymentCommissionable,
  resolvePaymentType,
} from "../../lib/paymentTypes";

const MAX_PAYMENT_SCAN_ROWS = 2500;

export type AttributedPayment = Doc<"paymentRecords"> & {
  effectiveCloserId: Id<"users"> | null;
};

export type RevenueBucket = {
  allPayments: Array<AttributedPayment>;
  finalPayments: Array<AttributedPayment>;
  depositPayments: Array<AttributedPayment>;
  finalRevenueMinor: number;
  depositRevenueMinor: number;
};

export type RevenueSplit = {
  filteredPayments: Array<AttributedPayment>;
  commissionable: RevenueBucket;
  nonCommissionable: RevenueBucket;
};

export function getUserDisplayName(
  user: Pick<Doc<"users">, "email" | "fullName"> | null | undefined,
): string {
  const fullName = user?.fullName?.trim();
  return fullName && fullName.length > 0
    ? fullName
    : (user?.email ?? "Unknown");
}

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

export function makeDateBounds(startDate: number, endDate: number) {
  assertValidDateRange(startDate, endDate);
  return {
    lower: { key: startDate, inclusive: true as const },
    upper: { key: endDate, inclusive: false as const },
  };
}

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

function getEffectiveCloserId(
  payment: Doc<"paymentRecords">,
): Id<"users"> | null {
  return resolveLegacyCompatibleAttributedCloserId(payment) ?? null;
}

function isCommissionablePayment(payment: Doc<"paymentRecords">): boolean {
  return resolveLegacyCompatiblePaymentCommissionable(payment);
}

function emptyRevenueBucket(): RevenueBucket {
  return {
    allPayments: [],
    finalPayments: [],
    depositPayments: [],
    finalRevenueMinor: 0,
    depositRevenueMinor: 0,
  };
}

export async function attributePaymentsToClosers(
  _ctx: QueryCtx,
  payments: Array<Doc<"paymentRecords">>,
): Promise<Array<AttributedPayment>> {
  return payments.map((payment) => ({
    ...payment,
    effectiveCloserId: getEffectiveCloserId(payment),
  }));
}

export function splitPaymentsForRevenueReporting(
  payments: Array<Doc<"paymentRecords"> | AttributedPayment>,
): RevenueSplit {
  const attributedPayments = payments.map((payment) => ({
    ...payment,
    effectiveCloserId:
      "effectiveCloserId" in payment
        ? payment.effectiveCloserId
        : getEffectiveCloserId(payment),
  }));

  const split: RevenueSplit = {
    filteredPayments: [],
    commissionable: emptyRevenueBucket(),
    nonCommissionable: emptyRevenueBucket(),
  };

  for (const payment of attributedPayments) {
    if (payment.status === "disputed") {
      continue;
    }

    split.filteredPayments.push(payment);
    const bucket = isCommissionablePayment(payment)
      ? split.commissionable
      : split.nonCommissionable;
    bucket.allPayments.push(payment);

    const paymentType = resolvePaymentType(payment.paymentType);
    if (paymentType === "deposit") {
      bucket.depositPayments.push(payment);
      bucket.depositRevenueMinor += payment.amountMinor;
    } else {
      bucket.finalPayments.push(payment);
      bucket.finalRevenueMinor += payment.amountMinor;
    }
  }

  return split;
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

export { COMMISSIONABLE_ORIGINS };
