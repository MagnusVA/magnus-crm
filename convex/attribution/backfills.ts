import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { attributionPatch, isInternalUtm, resolveAttributionForTenant } from "../lib/attribution/resolveAttribution";
import { rebuildQualificationRowsForOpportunity } from "../operations/projections";

type BackfillReport = {
  tenantsScanned: number;
  rowsScanned: number;
  rowsChanged: number;
  unmappedCount: number;
  internalCount: number;
  truncatedUtmCount: number;
};

function emptyReport(): BackfillReport {
  return {
    tenantsScanned: 0,
    rowsScanned: 0,
    rowsChanged: 0,
    unmappedCount: 0,
    internalCount: 0,
    truncatedUtmCount: 0,
  };
}

function addReport(target: BackfillReport, source: BackfillReport) {
  target.tenantsScanned += source.tenantsScanned;
  target.rowsScanned += source.rowsScanned;
  target.rowsChanged += source.rowsChanged;
  target.unmappedCount += source.unmappedCount;
  target.internalCount += source.internalCount;
  target.truncatedUtmCount += source.truncatedUtmCount;
}

async function listTenantIds(ctx: QueryCtx | MutationCtx) {
  const tenants = await ctx.db.query("tenants").take(100);
  return tenants.map((tenant) => tenant._id);
}

function bookedProgramPatch(config: Doc<"eventTypeConfigs"> | null | undefined) {
  return {
    bookingProgramId: config?.bookingProgramId,
    bookingProgramName: config?.bookingProgramName,
    bookingProgramMappingStatus:
      config?.bookingProgramMappingStatus ?? ("unmapped" as const),
  };
}

async function latestSoldProgramForOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
) {
  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .order("desc")
    .take(25);
  return payments.find((payment) => payment.status !== "disputed");
}

export const backfillMeetingAttribution = mutation({
  args: {
    dryRun: v.boolean(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { dryRun, limit }) => {
    const report = emptyReport();
    const tenantIds = await listTenantIds(ctx);

    for (const tenantId of tenantIds) {
      const tenantReport = emptyReport();
      tenantReport.tenantsScanned = 1;
      const meetings = await ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_scheduledAt", (q) =>
          q.eq("tenantId", tenantId),
        )
        .order("desc")
        .take(Math.min(limit ?? 200, 500));

      for (const meeting of meetings) {
        tenantReport.rowsScanned += 1;
        if (meeting.utmTruncated) {
          tenantReport.truncatedUtmCount += 1;
        }
        const opportunity = await ctx.db.get(meeting.opportunityId);
        const config = opportunity?.eventTypeConfigId
          ? await ctx.db.get(opportunity.eventTypeConfigId)
          : null;
        const resolved = await resolveAttributionForTenant(ctx, {
          tenantId,
          utmParams: meeting.utmParams,
        });
        if (resolved.resolutionStatus === "unmapped") {
          tenantReport.unmappedCount += 1;
        }
        if (resolved.resolutionStatus === "internal") {
          tenantReport.internalCount += 1;
        }
        const soldPayment = await latestSoldProgramForOpportunity(
          ctx,
          meeting.opportunityId,
        );
        const patch = {
          ...bookedProgramPatch(config),
          ...attributionPatch(resolved),
          soldProgramId: soldPayment?.programId,
          soldProgramName: soldPayment?.programName,
        };
        const changed =
          meeting.bookingProgramId !== patch.bookingProgramId ||
          meeting.bookingProgramName !== patch.bookingProgramName ||
          meeting.bookingProgramMappingStatus !==
            patch.bookingProgramMappingStatus ||
          meeting.attributionResolution !== patch.attributionResolution ||
          meeting.attributionTeamId !== patch.attributionTeamId ||
          meeting.dmCloserId !== patch.dmCloserId ||
          meeting.soldProgramId !== patch.soldProgramId ||
          meeting.soldProgramName !== patch.soldProgramName;
        if (changed) {
          tenantReport.rowsChanged += 1;
          if (!dryRun) {
            await ctx.db.patch(meeting._id, patch);
          }
        }
      }
      addReport(report, tenantReport);
    }

    return report;
  },
});

export const backfillOpportunityAttribution = mutation({
  args: {
    dryRun: v.boolean(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { dryRun, limit }) => {
    const report = emptyReport();
    const tenantIds = await listTenantIds(ctx);

    for (const tenantId of tenantIds) {
      const tenantReport = emptyReport();
      tenantReport.tenantsScanned = 1;
      const opportunities = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_latestActivityAt", (q) =>
          q.eq("tenantId", tenantId),
        )
        .order("desc")
        .take(Math.min(limit ?? 200, 500));

      for (const opportunity of opportunities) {
        tenantReport.rowsScanned += 1;
        const firstMeeting = opportunity.firstMeetingId
          ? await ctx.db.get(opportunity.firstMeetingId)
          : (
              await ctx.db
                .query("meetings")
                .withIndex("by_opportunityId_and_scheduledAt", (q) =>
                  q.eq("opportunityId", opportunity._id),
                )
                .order("asc")
                .take(1)
            )[0];
        const sourceUtm = firstMeeting?.utmParams ?? opportunity.utmParams;
        const resolved = await resolveAttributionForTenant(ctx, {
          tenantId,
          utmParams: sourceUtm,
        });
        if (resolved.resolutionStatus === "unmapped") {
          tenantReport.unmappedCount += 1;
        }
        if (resolved.resolutionStatus === "internal") {
          tenantReport.internalCount += 1;
        }
        if (firstMeeting?.utmTruncated) {
          tenantReport.truncatedUtmCount += 1;
        }
        const config = opportunity.eventTypeConfigId
          ? await ctx.db.get(opportunity.eventTypeConfigId)
          : null;
        const soldPayment = await latestSoldProgramForOpportunity(
          ctx,
          opportunity._id,
        );
        const shouldSetFirstBooking = firstMeeting && !isInternalUtm(sourceUtm);
        const bookingProgram = bookedProgramPatch(config);
        const patch = {
          ...(shouldSetFirstBooking
            ? {
                firstBookingProgramId: bookingProgram.bookingProgramId,
                firstBookingProgramName: bookingProgram.bookingProgramName,
                firstBookingProgramMappingStatus:
                  bookingProgram.bookingProgramMappingStatus,
                firstBookedAt: firstMeeting.scheduledAt,
                firstMeetingId: firstMeeting._id,
                firstMeetingAt: firstMeeting.scheduledAt,
                ...attributionPatch(resolved),
              }
            : {}),
          soldProgramId: soldPayment?.programId,
          soldProgramName: soldPayment?.programName,
          qualifiedAt:
            opportunity.qualifiedAt ??
            opportunity.qualifiedBy?.submittedAt ??
            opportunity.createdAt,
        };
        const changed =
          opportunity.firstBookingProgramId !== patch.firstBookingProgramId ||
          opportunity.firstBookingProgramName !== patch.firstBookingProgramName ||
          opportunity.firstBookingProgramMappingStatus !==
            patch.firstBookingProgramMappingStatus ||
          opportunity.firstMeetingId !== patch.firstMeetingId ||
          opportunity.firstMeetingAt !== patch.firstMeetingAt ||
          opportunity.attributionResolution !== patch.attributionResolution ||
          opportunity.attributionTeamId !== patch.attributionTeamId ||
          opportunity.dmCloserId !== patch.dmCloserId ||
          opportunity.soldProgramId !== patch.soldProgramId ||
          opportunity.soldProgramName !== patch.soldProgramName ||
          opportunity.qualifiedAt !== patch.qualifiedAt;
        if (changed) {
          tenantReport.rowsChanged += 1;
          if (!dryRun) {
            await ctx.db.patch(opportunity._id, patch);
            await rebuildQualificationRowsForOpportunity(ctx, opportunity._id);
          }
        }
      }
      addReport(report, tenantReport);
    }

    return report;
  },
});

export const verifyAttributionBackfill = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { limit }) => {
    const sampleSize = Math.min(limit ?? 200, 500);
    const tenantIds = await listTenantIds(ctx);
    let meetingsScanned = 0;
    let meetingsMissingAttributionResolution = 0;
    let meetingsMissingBookingProgramStatus = 0;
    let opportunitiesScanned = 0;
    let opportunitiesMissingQualifiedAt = 0;
    let opportunitiesMissingSoldProgramCache = 0;

    for (const tenantId of tenantIds) {
      const meetings = await ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_scheduledAt", (q) =>
          q.eq("tenantId", tenantId),
        )
        .order("desc")
        .take(sampleSize);
      const opportunities = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_latestActivityAt", (q) =>
          q.eq("tenantId", tenantId),
        )
        .order("desc")
        .take(sampleSize);

      meetingsScanned += meetings.length;
      meetingsMissingAttributionResolution += meetings.filter(
        (meeting) => meeting.attributionResolution === undefined,
      ).length;
      meetingsMissingBookingProgramStatus += meetings.filter(
        (meeting) => meeting.bookingProgramMappingStatus === undefined,
      ).length;
      opportunitiesScanned += opportunities.length;
      opportunitiesMissingQualifiedAt += opportunities.filter(
        (opportunity) => opportunity.qualifiedAt === undefined,
      ).length;
      opportunitiesMissingSoldProgramCache += opportunities.filter(
        (opportunity) =>
          opportunity.status === "payment_received" &&
          opportunity.soldProgramId === undefined,
      ).length;
    }

    return {
      tenantsScanned: tenantIds.length,
      meetingsScanned,
      meetingsMissingAttributionResolution,
      meetingsMissingBookingProgramStatus,
      opportunitiesScanned,
      opportunitiesMissingQualifiedAt,
      opportunitiesMissingSoldProgramCache,
    };
  },
});
