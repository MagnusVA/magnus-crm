import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { leadTimeline } from "./aggregates";
import {
  assertValidDateRange,
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
    assertValidDateRange(startDate, endDate);

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
    const isCustomersTruncated = customerRows.length > MAX_CONVERSION_SCAN_ROWS;
    const customers = customerRows.slice(0, MAX_CONVERSION_SCAN_ROWS);

    const winningOpportunityIds = [
      ...new Set(customers.map((customer) => customer.winningOpportunityId)),
    ];
    const leadIds = [...new Set(customers.map((customer) => customer.leadId))];
    const opportunityDocs = await Promise.all(
      winningOpportunityIds.map(async (opportunityId) => [
        opportunityId,
        await ctx.db.get(opportunityId),
      ] as const),
    );
    const leadDocs = await Promise.all(
      leadIds.map(async (leadId) => [leadId, await ctx.db.get(leadId)] as const),
    );
    const opportunityById = new Map(opportunityDocs);
    const leadById = new Map(leadDocs);
    const meetingsPerOpportunity = new Map<Id<"opportunities">, number>();

    for (const opportunityId of winningOpportunityIds) {
      let meetingCount = 0;
      for await (const _meeting of ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))) {
        meetingCount += 1;
      }
      meetingsPerOpportunity.set(opportunityId, meetingCount);
    }

    const conversionsByCloser = new Map<Id<"users">, number>();
    let totalConversions = 0;
    let excludedConversions = 0;
    let totalMeetingsOnWinners = 0;
    let winnersWithMeetings = 0;
    let totalTimeToConversionMs = 0;
    let timeToConversionSampleCount = 0;

    for (const customer of customers) {
      const meetingsOnWinner =
        meetingsPerOpportunity.get(customer.winningOpportunityId) ?? 0;
      if (meetingsOnWinner > 0) {
        totalMeetingsOnWinners += meetingsOnWinner;
        winnersWithMeetings += 1;
      }

      const lead = leadById.get(customer.leadId);
      if (lead) {
        const timeToConversionMs = customer.convertedAt - lead.firstSeenAt;
        if (timeToConversionMs >= 0) {
          totalTimeToConversionMs += timeToConversionMs;
          timeToConversionSampleCount += 1;
        }
      }

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
      avgMeetingsPerSale:
        winnersWithMeetings > 0 ? totalMeetingsOnWinners / winnersWithMeetings : null,
      meetingsPerSaleNumerator: totalMeetingsOnWinners,
      meetingsPerSaleDenominator: winnersWithMeetings,
      avgTimeToConversionMs:
        timeToConversionSampleCount > 0
          ? totalTimeToConversionMs / timeToConversionSampleCount
          : null,
      timeToConversionSampleCount,
      byCloser,
      excludedConversions,
      isCustomersTruncated,
      isConversionDataTruncated: isCustomersTruncated,
    };
  },
});
