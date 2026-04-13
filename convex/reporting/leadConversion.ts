import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { leadTimeline } from "./aggregates";
import {
  getActiveClosers,
  getUserDisplayName,
  makeDateBounds,
} from "./lib/helpers";

const MAX_CONVERSION_SCAN_ROWS = 2500;

export const getLeadConversionMetrics = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const closers = await getActiveClosers(ctx, tenantId);
    const activeCloserIds = new Set<Id<"users">>(closers.map((closer) => closer._id));
    const newLeads = await leadTimeline.count(ctx, {
      namespace: tenantId,
      bounds: makeDateBounds(startDate, endDate),
    });

    const customerRows = await ctx.db
      .query("customers")
      .withIndex("by_tenantId_and_convertedAt", (q) =>
        q.eq("tenantId", tenantId).gte("convertedAt", startDate).lt("convertedAt", endDate),
      )
      .take(MAX_CONVERSION_SCAN_ROWS + 1);
    const customers = customerRows.slice(0, MAX_CONVERSION_SCAN_ROWS);

    const winningOpportunityIds = [
      ...new Set(customers.map((customer) => customer.winningOpportunityId)),
    ];
    const opportunityDocs = await Promise.all(
      winningOpportunityIds.map(async (opportunityId) => [
        opportunityId,
        await ctx.db.get(opportunityId),
      ] as const),
    );
    const opportunityById = new Map(opportunityDocs);

    const conversionsByCloser = new Map<Id<"users">, number>();
    let totalConversions = 0;
    let excludedConversions = 0;

    for (const customer of customers) {
      const effectiveCloserId =
        opportunityById.get(customer.winningOpportunityId)?.assignedCloserId ??
        customer.convertedByUserId;

      if (!effectiveCloserId || !activeCloserIds.has(effectiveCloserId)) {
        excludedConversions += 1;
        continue;
      }

      totalConversions += 1;
      conversionsByCloser.set(
        effectiveCloserId,
        (conversionsByCloser.get(effectiveCloserId) ?? 0) + 1,
      );
    }

    const byCloser = closers
      .map((closer) => ({
        closerId: closer._id,
        closerName: getUserDisplayName(closer),
        conversions: conversionsByCloser.get(closer._id) ?? 0,
      }))
      .sort(
        (left, right) =>
          right.conversions - left.conversions ||
          left.closerName.localeCompare(right.closerName),
      );

    return {
      newLeads,
      totalConversions,
      conversionRate:
        newLeads > 0 ? totalConversions / newLeads : null,
      byCloser,
      excludedConversions,
      isConversionDataTruncated: customerRows.length > MAX_CONVERSION_SCAN_ROWS,
    };
  },
});
