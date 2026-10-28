import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { countLeadStageEntries } from "../lib/leadLifecycle";
import {
  enrollmentFirstPayment,
  listFirstEnrollmentsInRange,
} from "../enrollments/firstEnrollments";
import {
  assertValidDateRange,
  getActiveClosers,
  getUserDisplayName,
  reportingUserIdentity,
} from "./lib/helpers";

// Meetings counted on one winning deal for meetings per sale. A deal books a
// handful; the cap only bounds the read.
const MAX_MEETINGS_PER_WINNER = 200;

export const MAX_CONVERSION_SCAN_ROWS = 2500;

/** One person becoming a customer, as the Leads & Conversions report counts it. */
export type LeadConversion = {
  leadId: Id<"leads">;
  convertedAt: number;
  winningOpportunityId: Id<"opportunities">;
  /** Who recorded the first payment; credited when the deal has no closer. */
  convertedByUserId: Id<"users"> | undefined;
};

export type LeadConversionList = {
  conversions: LeadConversion[];
  isTruncated: boolean;
};

/**
 * The conversions in [startDate, endDate), read from first enrollments
 * (docs/plans/phase-4-customers.md §6.3): the enrollment's deal is the
 * winning deal, and its first payment's recorder is the fallback closer.
 */
export async function conversionsFromEnrollments(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  startDate: number,
  endDate: number,
): Promise<LeadConversionList> {
  const { enrollments, isTruncated } = await listFirstEnrollmentsInRange(
    ctx,
    tenantId,
    startDate,
    endDate,
    MAX_CONVERSION_SCAN_ROWS,
  );
  const conversions = await Promise.all(
    enrollments.map(async (enrollment) => ({
      leadId: enrollment.leadId,
      convertedAt: enrollment.enrolledAt,
      winningOpportunityId: enrollment.opportunityId,
      convertedByUserId: (await enrollmentFirstPayment(ctx, enrollment))?.recordedByUserId,
    })),
  );
  return { conversions, isTruncated };
}

export type LeadConversionMetrics = {
  newLeads: number;
  totalConversions: number;
  conversionRate: number | null;
  avgMeetingsPerSale: number | null;
  meetingsPerSaleNumerator: number;
  meetingsPerSaleDenominator: number;
  avgTimeToConversionMs: number | null;
  timeToConversionSampleCount: number;
  excludedConversions: number;
  conversionsByCloser: Map<Id<"users">, number>;
  isConversionDataTruncated: boolean;
};

/**
 * What the metrics read about each conversion's deal and person: the deal's
 * closer, the person's first-seen time, and the meetings on the deal.
 */
export type LeadConversionFacts = {
  closerByOpportunity: Map<Id<"opportunities">, Id<"users"> | undefined>;
  firstSeenAtByLead: Map<Id<"leads">, number>;
  meetingsPerOpportunity: Map<Id<"opportunities">, number>;
};

export async function loadLeadConversionFacts(
  ctx: QueryCtx,
  conversions: LeadConversion[],
): Promise<LeadConversionFacts> {
  const winningOpportunityIds = [
    ...new Set(conversions.map((conversion) => conversion.winningOpportunityId)),
  ];
  const leadIds = [...new Set(conversions.map((conversion) => conversion.leadId))];
  const opportunityDocs = await Promise.all(
    winningOpportunityIds.map(async (opportunityId) => [
      opportunityId,
      await ctx.db.get("opportunities", opportunityId),
    ] as const),
  );
  const leadDocs = await Promise.all(
    leadIds.map(async (leadId) => [leadId, await ctx.db.get("leads", leadId)] as const),
  );
  const closerByOpportunity = new Map<Id<"opportunities">, Id<"users"> | undefined>();
  for (const [opportunityId, opportunity] of opportunityDocs) {
    if (opportunity) closerByOpportunity.set(opportunityId, opportunity.assignedCloserId);
  }
  const firstSeenAtByLead = new Map<Id<"leads">, number>();
  for (const [leadId, lead] of leadDocs) {
    if (lead) firstSeenAtByLead.set(leadId, lead.firstSeenAt);
  }
  const meetingsPerOpportunity = new Map<Id<"opportunities">, number>();

  for (const opportunityId of winningOpportunityIds) {
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
      .take(MAX_MEETINGS_PER_WINNER);
    meetingsPerOpportunity.set(opportunityId, meetings.length);
  }

  return { closerByOpportunity, firstSeenAtByLead, meetingsPerOpportunity };
}

/**
 * Every Leads & Conversions number from a list of conversions. A conversion
 * counts for its winning deal's closer, else its recorder, when that user is
 * an active closer; otherwise it is excluded.
 */
export function summarizeLeadConversions(
  args: {
    newLeads: number;
    list: LeadConversionList;
    activeCloserIds: ReadonlySet<Id<"users">>;
  },
  facts: LeadConversionFacts,
): LeadConversionMetrics {
  const { newLeads, list, activeCloserIds } = args;
  const { conversions } = list;
  const { closerByOpportunity, firstSeenAtByLead, meetingsPerOpportunity } = facts;

  const conversionsByCloser = new Map<Id<"users">, number>();
  let totalConversions = 0;
  let excludedConversions = 0;
  let totalMeetingsOnWinners = 0;
  let winnersWithMeetings = 0;
  let totalTimeToConversionMs = 0;
  let timeToConversionSampleCount = 0;

  for (const conversion of conversions) {
    const meetingsOnWinner =
      meetingsPerOpportunity.get(conversion.winningOpportunityId) ?? 0;
    if (meetingsOnWinner > 0) {
      totalMeetingsOnWinners += meetingsOnWinner;
      winnersWithMeetings += 1;
    }

    const firstSeenAt = firstSeenAtByLead.get(conversion.leadId);
    if (firstSeenAt !== undefined) {
      const timeToConversionMs = conversion.convertedAt - firstSeenAt;
      if (timeToConversionMs >= 0) {
        totalTimeToConversionMs += timeToConversionMs;
        timeToConversionSampleCount += 1;
      }
    }

    const effectiveCloserId =
      closerByOpportunity.get(conversion.winningOpportunityId) ??
      conversion.convertedByUserId;

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

  return {
    newLeads,
    totalConversions,
    conversionRate: newLeads > 0 ? totalConversions / newLeads : null,
    avgMeetingsPerSale:
      winnersWithMeetings > 0 ? totalMeetingsOnWinners / winnersWithMeetings : null,
    meetingsPerSaleNumerator: totalMeetingsOnWinners,
    meetingsPerSaleDenominator: winnersWithMeetings,
    avgTimeToConversionMs:
      timeToConversionSampleCount > 0
        ? totalTimeToConversionMs / timeToConversionSampleCount
        : null,
    timeToConversionSampleCount,
    excludedConversions,
    conversionsByCloser,
    isConversionDataTruncated: list.isTruncated,
  };
}

/**
 * The Leads & Conversions report from the range's new leads, conversions and
 * their facts. Shared by the Convex reader and the ClickHouse report
 * (convex/analytics/definitions/leads.ts).
 */
export async function buildLeadConversionMetrics(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  input: { newLeads: number; list: LeadConversionList; facts: LeadConversionFacts },
) {
  const closers = await getActiveClosers(ctx, tenantId);
  const activeCloserIds = new Set<Id<"users">>(closers.map((closer) => closer._id));
  const { conversionsByCloser, ...metrics } = summarizeLeadConversions(
    { newLeads: input.newLeads, list: input.list, activeCloserIds },
    input.facts,
  );

  const byCloser = (await Promise.all(closers
    .map(async (closer) => ({
      closerId: closer._id,
      closerName: getUserDisplayName(closer),
      closer: await reportingUserIdentity(ctx, closer),
      conversions: conversionsByCloser.get(closer._id) ?? 0,
    }))))
    .sort(
      (left, right) =>
        right.conversions - left.conversions ||
        left.closerName.localeCompare(right.closerName),
    );

  return {
    newLeads: metrics.newLeads,
    totalConversions: metrics.totalConversions,
    conversionRate: metrics.conversionRate,
    avgMeetingsPerSale: metrics.avgMeetingsPerSale,
    meetingsPerSaleNumerator: metrics.meetingsPerSaleNumerator,
    meetingsPerSaleDenominator: metrics.meetingsPerSaleDenominator,
    avgTimeToConversionMs: metrics.avgTimeToConversionMs,
    timeToConversionSampleCount: metrics.timeToConversionSampleCount,
    byCloser,
    excludedConversions: metrics.excludedConversions,
    isConversionDataTruncated: metrics.isConversionDataTruncated,
  };
}

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

    // A new lead is a person who reached Qualified in the range, not a row
    // created in it (docs/plans/phase-1-foundations.md §7.1).
    const newLeads = await countLeadStageEntries(ctx, tenantId, "qualified", startDate, endDate);
    const list = await conversionsFromEnrollments(ctx, tenantId, startDate, endDate);
    const facts = await loadLeadConversionFacts(ctx, list.conversions);
    return await buildLeadConversionMetrics(ctx, tenantId, { newLeads, list, facts });
  },
});
