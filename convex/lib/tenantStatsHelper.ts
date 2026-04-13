import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type TenantStatsDelta = {
  totalTeamMembers?: number;
  totalClosers?: number;
  totalOpportunities?: number;
  activeOpportunities?: number;
  wonDeals?: number;
  lostDeals?: number;
  totalRevenueMinor?: number;
  totalPaymentRecords?: number;
  totalLeads?: number;
  totalCustomers?: number;
};

type TenantStatsField = keyof TenantStatsDelta;

const TENANT_STATS_FIELDS: TenantStatsField[] = [
  "totalTeamMembers",
  "totalClosers",
  "totalOpportunities",
  "activeOpportunities",
  "wonDeals",
  "lostDeals",
  "totalRevenueMinor",
  "totalPaymentRecords",
  "totalLeads",
  "totalCustomers",
];

export const ACTIVE_OPPORTUNITY_STATUSES = new Set([
  "scheduled",
  "in_progress",
  "follow_up_scheduled",
  "reschedule_link_sent",
] as const);

export function isActiveOpportunityStatus(status: string): boolean {
  return ACTIVE_OPPORTUNITY_STATUSES.has(
    status as (typeof ACTIVE_OPPORTUNITY_STATUSES extends Set<infer T> ? T : never),
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
    console.warn("[TenantStats] Missing stats document, auto-creating", {
      tenantId,
      delta,
    });
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
    patch[field] = (stats[field] ?? 0) + value;
  }

  await ctx.db.patch(stats._id, patch);
}
