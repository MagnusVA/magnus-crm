import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { log, reportError } from "./observability/log";
import type { PaymentType } from "./paymentTypes";

export type TenantStatsDelta = {
  totalTeamMembers?: number;
  totalClosers?: number;
  totalOpportunities?: number;
  activeOpportunities?: number;
  wonDeals?: number;
  lostDeals?: number;
  totalRevenueMinor?: number;
  totalCommissionableFinalRevenueMinor?: number;
  totalCommissionableDepositRevenueMinor?: number;
  totalNonCommissionableFinalRevenueMinor?: number;
  totalNonCommissionableDepositRevenueMinor?: number;
  totalPaymentRecords?: number;
  totalLeads?: number;
  totalCustomers?: number;
};

export type PaymentStatsDelta = {
  commissionable: boolean;
  paymentType: PaymentType;
  amountMinorDelta: number;
  wonDealDelta?: number;
  activeOpportunityDelta?: number;
};

type PaymentRevenueBucket =
  | "totalCommissionableFinalRevenueMinor"
  | "totalCommissionableDepositRevenueMinor"
  | "totalNonCommissionableFinalRevenueMinor"
  | "totalNonCommissionableDepositRevenueMinor";

type TenantStatsField = keyof TenantStatsDelta;

const TENANT_STATS_FIELDS: TenantStatsField[] = [
  "totalTeamMembers",
  "totalClosers",
  "totalOpportunities",
  "activeOpportunities",
  "wonDeals",
  "lostDeals",
  "totalRevenueMinor",
  "totalCommissionableFinalRevenueMinor",
  "totalCommissionableDepositRevenueMinor",
  "totalNonCommissionableFinalRevenueMinor",
  "totalNonCommissionableDepositRevenueMinor",
  "totalPaymentRecords",
  "totalLeads",
  "totalCustomers",
];

export const ACTIVE_OPPORTUNITY_STATUSES = new Set([
  "qualified_pending",
  "scheduled",
  "follow_up_scheduled",
  "reschedule_link_sent",
] as const);

export function isActiveOpportunityStatus(status: string): boolean {
  return ACTIVE_OPPORTUNITY_STATUSES.has(
    status as (typeof ACTIVE_OPPORTUNITY_STATUSES extends Set<infer T> ? T : never),
  );
}

function paymentRevenueBucket(payment: Doc<"paymentRecords">): PaymentRevenueBucket {
  if (payment.commissionable) {
    return payment.paymentType === "deposit"
      ? "totalCommissionableDepositRevenueMinor"
      : "totalCommissionableFinalRevenueMinor";
  }

  return payment.paymentType === "deposit"
    ? "totalNonCommissionableDepositRevenueMinor"
    : "totalNonCommissionableFinalRevenueMinor";
}

function reportNegativeCounter(
  tenantId: Id<"tenants">,
  field: TenantStatsField,
) {
  reportError(
    "tenant_stats.negative_counter",
    new Error("Tenant stats counter went negative"),
    {
      severity: "error",
      fingerprint: `tenant_stats.negative_counter:${field}`,
      tenantId,
      field,
    },
  );
}

export async function updateTenantStats(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  delta: TenantStatsDelta,
): Promise<void> {
  const stats = await ctx.db
    .query("tenantStats")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .unique();

  if (!stats) {
    // The stats doc is created lazily on a tenant's first counted write.
    log.info("tenant_stats.initialized", { tenantId });
    const initial: Record<string, unknown> = {
      tenantId,
      totalTeamMembers: 0,
      totalClosers: 0,
      totalOpportunities: 0,
      activeOpportunities: 0,
      wonDeals: 0,
      lostDeals: 0,
      totalRevenueMinor: 0,
      totalPaymentRecords: 0,
      totalLeads: 0,
      totalCustomers: 0,
      lastUpdatedAt: Date.now(),
    };
    for (const field of TENANT_STATS_FIELDS) {
      const value = delta[field];
      if (value !== undefined && value !== 0) {
        if (value < 0) {
          reportNegativeCounter(tenantId, field);
        }
        initial[field] = Math.max(0, value);
      }
    }
    await ctx.db.insert("tenantStats", initial as never);
    return;
  }

  const patch: Record<string, number> = { lastUpdatedAt: Date.now() };
  for (const field of TENANT_STATS_FIELDS) {
    const value = delta[field];
    if (value === undefined || value === 0) {
      continue;
    }
    const next = (stats[field] ?? 0) + value;
    if (value < 0 && next < 0) {
      reportNegativeCounter(tenantId, field);
    }
    patch[field] = next;
  }

  await ctx.db.patch("tenantStats", stats._id, patch);
}

export async function applyPaymentStatsDelta(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  delta: PaymentStatsDelta,
): Promise<void> {
  const bucketKey =
    delta.commissionable
      ? delta.paymentType === "deposit"
        ? "totalCommissionableDepositRevenueMinor"
        : "totalCommissionableFinalRevenueMinor"
      : delta.paymentType === "deposit"
        ? "totalNonCommissionableDepositRevenueMinor"
        : "totalNonCommissionableFinalRevenueMinor";

  await updateTenantStats(ctx, tenantId, {
    activeOpportunities: delta.activeOpportunityDelta ?? 0,
    totalPaymentRecords:
      delta.amountMinorDelta === 0 ? 0 : Math.sign(delta.amountMinorDelta),
    totalRevenueMinor: delta.amountMinorDelta,
    [bucketKey]: delta.amountMinorDelta,
    wonDeals: delta.wonDealDelta ?? 0,
  });
}

export async function replaceTenantPaymentStatsForCorrection(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  args: {
    before: Doc<"paymentRecords">;
    after: Doc<"paymentRecords">;
  },
): Promise<void> {
  const beforeAmount =
    args.before.status === "disputed" ? 0 : args.before.amountMinor;
  const afterAmount =
    args.after.status === "disputed" ? 0 : args.after.amountMinor;
  const beforeBucket = paymentRevenueBucket(args.before);
  const afterBucket = paymentRevenueBucket(args.after);

  const delta: TenantStatsDelta = {
    totalRevenueMinor: afterAmount - beforeAmount,
  };

  if (beforeBucket === afterBucket) {
    delta[beforeBucket] = afterAmount - beforeAmount;
  } else {
    delta[beforeBucket] = -beforeAmount;
    delta[afterBucket] = afterAmount;
  }

  await updateTenantStats(ctx, tenantId, delta);
}
