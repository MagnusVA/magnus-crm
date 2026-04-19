import { v } from "convex/values";
import type { PaginationOptions } from "convex/server";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalQuery, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const opportunityStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("meeting_overran"),
  v.literal("payment_received"),
  v.literal("follow_up_scheduled"),
  v.literal("reschedule_link_sent"),
  v.literal("lost"),
  v.literal("canceled"),
  v.literal("no_show"),
);

type LeadSummary = {
  fullName?: string;
  email?: string;
};

type UserSummary = {
  fullName?: string;
  email: string;
  role: Doc<"users">["role"];
};

type MeetingSummary = {
  _id: Id<"meetings">;
  scheduledAt: number;
  status: Doc<"meetings">["status"];
};

export const getById = internalQuery({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    console.log("[Opportunities] getById called", { opportunityId });
    return await ctx.db.get(opportunityId);
  },
});

/**
 * Build the right paginated index query for the 8 filter combinations:
 * (status × closer × date) each map to a dedicated composite index.
 */
async function buildPaginatedOpportunityQuery(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  filters: {
    statusFilter?: Doc<"opportunities">["status"];
    assignedCloserId?: Id<"users">;
    periodStart?: number;
    periodEnd?: number;
  },
  paginationOpts: PaginationOptions,
) {
  const { statusFilter, assignedCloserId, periodStart, periodEnd } = filters;
  const hasDate = periodStart !== undefined && periodEnd !== undefined;

  // Status + Closer + Date
  if (statusFilter && assignedCloserId && hasDate) {
    return ctx.db
      .query("opportunities")
      .withIndex(
        "by_tenantId_and_assignedCloserId_and_status_and_createdAt",
        (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", assignedCloserId)
            .eq("status", statusFilter)
            .gte("createdAt", periodStart)
            .lt("createdAt", periodEnd),
      )
      .order("desc")
      .paginate(paginationOpts);
  }

  // Status + Date (no closer)
  if (statusFilter && hasDate) {
    return ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("status", statusFilter)
          .gte("createdAt", periodStart)
          .lt("createdAt", periodEnd),
      )
      .order("desc")
      .paginate(paginationOpts);
  }

  // Closer + Date (no status)
  if (assignedCloserId && hasDate) {
    return ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", assignedCloserId)
          .gte("createdAt", periodStart)
          .lt("createdAt", periodEnd),
      )
      .order("desc")
      .paginate(paginationOpts);
  }

  // Date only
  if (hasDate) {
    return ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("createdAt", periodStart)
          .lt("createdAt", periodEnd),
      )
      .order("desc")
      .paginate(paginationOpts);
  }

  // Status + Closer (no date)
  if (statusFilter && assignedCloserId) {
    return ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", assignedCloserId)
          .eq("status", statusFilter),
      )
      .order("desc")
      .paginate(paginationOpts);
  }

  // Status only
  if (statusFilter) {
    return ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_status", (q) =>
        q.eq("tenantId", tenantId).eq("status", statusFilter),
      )
      .order("desc")
      .paginate(paginationOpts);
  }

  // Closer only
  if (assignedCloserId) {
    return ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", assignedCloserId),
      )
      .order("desc")
      .paginate(paginationOpts);
  }

  // No filters
  return ctx.db
    .query("opportunities")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .order("desc")
    .paginate(paginationOpts);
}

/**
 * List opportunities for tenant owner/admin with optional filters.
 * Includes lead, closer, event type, and latest meeting metadata.
 */
export const listOpportunitiesForAdmin = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(opportunityStatusValidator),
    assignedCloserId: v.optional(v.id("users")),
    periodStart: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
  },
  handler: async (ctx, { paginationOpts, statusFilter, assignedCloserId, periodStart, periodEnd }) => {
    console.log("[Opportunities] listOpportunitiesForAdmin called", {
      statusFilter: statusFilter ?? "all",
      assignedCloserId: assignedCloserId ?? "none",
      periodStart: periodStart ?? "none",
      periodEnd: periodEnd ?? "none",
    });
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    if (assignedCloserId) {
      const closer = await ctx.db.get(assignedCloserId);
      if (
        !closer ||
        closer.tenantId !== tenantId ||
        closer.role !== "closer"
      ) {
        throw new Error("Invalid closer filter");
      }
    }

    const hasDate = periodStart !== undefined && periodEnd !== undefined;

    // 8 filter combinations, each targeting a dedicated index for efficient pagination.
    // Date-filtered branches use range operators on createdAt (last index field).
    const paginatedResult = await buildPaginatedOpportunityQuery(
      ctx,
      tenantId,
      { statusFilter, assignedCloserId, periodStart: hasDate ? periodStart : undefined, periodEnd: hasDate ? periodEnd : undefined },
      paginationOpts,
    );

    const opportunities = paginatedResult.page;

    const leadIds = new Set<Id<"leads">>();
    const closerIds = new Set<Id<"users">>();
    const eventTypeConfigIds = new Set<Id<"eventTypeConfigs">>();

    for (const opportunity of opportunities) {
      leadIds.add(opportunity.leadId);
      if (opportunity.assignedCloserId) {
        closerIds.add(opportunity.assignedCloserId);
      }
      if (opportunity.eventTypeConfigId) {
        eventTypeConfigIds.add(opportunity.eventTypeConfigId);
      }
    }

    const [leads, closers, eventTypes] = await Promise.all([
      Promise.all(
        [...leadIds].map(async (leadId) => ({
          leadId,
          lead: await ctx.db.get(leadId),
        })),
      ),
      Promise.all(
        [...closerIds].map(async (closerId) => ({
          closerId,
          closer: await ctx.db.get(closerId),
        })),
      ),
      Promise.all(
        [...eventTypeConfigIds].map(async (eventTypeConfigId) => ({
          eventTypeConfigId,
          eventTypeConfig: await ctx.db.get(eventTypeConfigId),
        })),
      ),
    ]);

    const leadById = new Map<Id<"leads">, LeadSummary>();
    for (const { leadId, lead } of leads) {
      if (lead) {
        leadById.set(leadId, {
          fullName: lead.fullName,
          email: lead.email,
        });
      }
    }

    const closerById = new Map<Id<"users">, UserSummary>();
    for (const { closerId, closer } of closers) {
      if (closer) {
        closerById.set(closerId, {
          fullName: closer.fullName,
          email: closer.email,
          role: closer.role,
        });
      }
    }

    const eventTypeById = new Map<Id<"eventTypeConfigs">, string>();
    for (const { eventTypeConfigId, eventTypeConfig } of eventTypes) {
      if (eventTypeConfig) {
        eventTypeById.set(eventTypeConfigId, eventTypeConfig.displayName);
      }
    }

    // Fetch the denormalized latest/next meeting references for each opportunity
    // (see @plans/caching/caching.md: these are maintained by the mutation that creates/updates meetings)
    const meetingDataByOppId = new Map<string, { latestMeeting: MeetingSummary | null; nextMeeting: MeetingSummary | null }>();
    const meetingIdsToFetch = new Set<string>();

    for (const opp of opportunities) {
      if (opp.latestMeetingId) {
        meetingIdsToFetch.add(opp.latestMeetingId.toString());
      }
      if (opp.nextMeetingId) {
        meetingIdsToFetch.add(opp.nextMeetingId.toString());
      }
    }

    const meetings = await Promise.all(
      [...meetingIdsToFetch].map(async (meetingId) => ({
        meetingId,
        meeting: await ctx.db.get(meetingId as Id<"meetings">),
      })),
    );
    const meetingById = new Map<string, MeetingSummary>();
    for (const { meetingId, meeting } of meetings) {
      if (meeting) {
        meetingById.set(meetingId, {
          _id: meeting._id,
          scheduledAt: meeting.scheduledAt,
          status: meeting.status,
        });
      }
    }

    for (const opp of opportunities) {
      const latestMeeting = opp.latestMeetingId ? meetingById.get(opp.latestMeetingId.toString()) ?? null : null;
      const nextMeeting = opp.nextMeetingId ? meetingById.get(opp.nextMeetingId.toString()) ?? null : null;
      meetingDataByOppId.set(opp._id.toString(), { latestMeeting, nextMeeting });
    }

    const enriched = await Promise.all(
      opportunities.map(async (opportunity) => {
        const lead = leadById.get(opportunity.leadId);
        const closer = opportunity.assignedCloserId
          ? closerById.get(opportunity.assignedCloserId)
          : undefined;
        const assignedCloser = closer?.role === "closer" ? closer : undefined;
        const eventTypeName = opportunity.eventTypeConfigId
          ? eventTypeById.get(opportunity.eventTypeConfigId)
          : undefined;

        const { latestMeeting, nextMeeting } = meetingDataByOppId.get(opportunity._id.toString()) ?? {
          latestMeeting: null,
          nextMeeting: null,
        };

        return {
          ...opportunity,
          leadName: lead?.fullName ?? lead?.email ?? "Unknown",
          leadEmail: lead?.email,
          closerName:
            assignedCloser?.fullName ?? assignedCloser?.email ?? "Unassigned",
          closerEmail: assignedCloser?.email,
          hostCalendlyUserUri: opportunity.hostCalendlyUserUri ?? null,
          hostCalendlyEmail: opportunity.hostCalendlyEmail ?? null,
          hostCalendlyName: opportunity.hostCalendlyName ?? null,
          eventTypeName: eventTypeName ?? null,
          latestMeetingId: latestMeeting?._id ?? null,
          latestMeetingAt: latestMeeting?.scheduledAt ?? null,
          latestMeetingStatus: latestMeeting?.status ?? null,
          nextMeetingId: nextMeeting?._id ?? null,
          nextMeetingAt: nextMeeting?.scheduledAt ?? null,
          nextMeetingStatus: nextMeeting?.status ?? null,
          meetingStatus: nextMeeting?.status ?? latestMeeting?.status ?? null,
        };
      }),
    );

    console.log("[Opportunities] listOpportunitiesForAdmin result", { count: enriched.length });
    return {
      ...paginatedResult,
      page: enriched.sort((a, b) => b.updatedAt - a.updatedAt),
    };
  },
});
