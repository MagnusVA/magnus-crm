import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const opportunityStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("payment_received"),
  v.literal("follow_up_scheduled"),
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
 * List opportunities for tenant owner/admin with optional filters.
 * Includes lead, closer, event type, and latest meeting metadata.
 */
export const listOpportunitiesForAdmin = query({
  args: {
    statusFilter: v.optional(opportunityStatusValidator),
    assignedCloserId: v.optional(v.id("users")),
  },
  handler: async (ctx, { statusFilter, assignedCloserId }) => {
    console.log("[Opportunities] listOpportunitiesForAdmin called", { statusFilter: statusFilter ?? "all", assignedCloserId: assignedCloserId ?? "none" });
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

    const opportunities: Array<Doc<"opportunities">> = [];
    if (statusFilter) {
      for await (const opportunity of ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_status", (q) =>
          q.eq("tenantId", tenantId).eq("status", statusFilter),
        )) {
        if (
          assignedCloserId !== undefined &&
          opportunity.assignedCloserId !== assignedCloserId
        ) {
          continue;
        }
        opportunities.push(opportunity);
      }
    } else if (assignedCloserId) {
      for await (const opportunity of ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId", (q) =>
          q.eq("tenantId", tenantId).eq("assignedCloserId", assignedCloserId),
        )) {
        opportunities.push(opportunity);
      }
    } else {
      for await (const opportunity of ctx.db
        .query("opportunities")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
        opportunities.push(opportunity);
      }
    }

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

    const leadById = new Map<Id<"leads">, LeadSummary>();
    for (const leadId of leadIds) {
      const lead = await ctx.db.get(leadId);
      if (lead) {
        leadById.set(leadId, {
          fullName: lead.fullName,
          email: lead.email,
        });
      }
    }

    const closerById = new Map<Id<"users">, UserSummary>();
    for (const closerId of closerIds) {
      const closer = await ctx.db.get(closerId);
      if (closer) {
        closerById.set(closerId, {
          fullName: closer.fullName,
          email: closer.email,
          role: closer.role,
        });
      }
    }

    const eventTypeById = new Map<Id<"eventTypeConfigs">, string>();
    for (const eventTypeConfigId of eventTypeConfigIds) {
      const eventTypeConfig = await ctx.db.get(eventTypeConfigId);
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

    const meetingById = new Map<string, MeetingSummary>();
    for (const meetingId of meetingIdsToFetch) {
      const meeting = await ctx.db.get(meetingId as Id<"meetings">);
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
    return enriched.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});
