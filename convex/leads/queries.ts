import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const leadStatusValidator = v.union(
  v.literal("active"),
  v.literal("converted"),
  v.literal("merged"),
);

type LeadListItem = Doc<"leads"> & {
  opportunityCount: number;
  latestMeetingAt: number | null;
  assignedCloserName: string | null;
};

type LeadDetailOpportunity = Doc<"opportunities"> & {
  closerName: string | null;
  eventTypeName: string | null;
};

type LeadDetailMeeting = Doc<"meetings"> & {
  opportunityStatus: Doc<"opportunities">["status"];
  closerName: string | null;
};

type LeadMergeHistoryEntry = Doc<"leadMergeHistory"> & {
  mergedByUserName: string;
  sourceLeadName: string;
  targetLeadName: string;
};

function getDisplayName(
  doc: Pick<Doc<"users">, "fullName" | "email"> | Pick<Doc<"leads">, "fullName" | "email"> | null,
): string {
  if (!doc) {
    return "Unknown";
  }

  return doc.fullName ?? doc.email;
}

export const listLeads = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(leadStatusValidator),
  },
  handler: async (ctx, { paginationOpts, statusFilter }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);
    const effectiveStatus = statusFilter ?? "active";

    const rawResults = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_status", (q) =>
        q.eq("tenantId", tenantId).eq("status", effectiveStatus),
      )
      .order("desc")
      .paginate(paginationOpts);

    const closerNameCache = new Map<Id<"users">, string | null>();
    const enrichedPage = await Promise.all(
      rawResults.page.map(async (lead): Promise<LeadListItem> => {
        const opportunities = await ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_leadId", (q) =>
            q.eq("tenantId", tenantId).eq("leadId", lead._id),
          )
          .order("desc")
          .take(50);

        let latestMeetingAt: number | null = null;
        let assignedCloserName: string | null = null;

        for (const opportunity of opportunities) {
          if (
            opportunity.latestMeetingAt !== undefined &&
            (latestMeetingAt === null ||
              opportunity.latestMeetingAt > latestMeetingAt)
          ) {
            latestMeetingAt = opportunity.latestMeetingAt;
          }

          if (assignedCloserName || !opportunity.assignedCloserId) {
            continue;
          }

          if (!closerNameCache.has(opportunity.assignedCloserId)) {
            const closer = await ctx.db.get(opportunity.assignedCloserId);
            closerNameCache.set(
              opportunity.assignedCloserId,
              closer && closer.tenantId === tenantId
                ? closer.fullName ?? closer.email
                : null,
            );
          }

          assignedCloserName =
            closerNameCache.get(opportunity.assignedCloserId) ?? null;
        }

        return {
          ...lead,
          opportunityCount: opportunities.length,
          latestMeetingAt,
          assignedCloserName,
        };
      }),
    );

    console.log("[Leads:List] listLeads completed", {
      tenantId,
      statusFilter: effectiveStatus,
      pageSize: enrichedPage.length,
      isDone: rawResults.isDone,
    });

    return {
      ...rawResults,
      page: enrichedPage,
    };
  },
});

export const searchLeads = query({
  args: {
    searchTerm: v.string(),
    statusFilter: v.optional(leadStatusValidator),
  },
  handler: async (ctx, { searchTerm, statusFilter }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const trimmed = searchTerm.trim();
    if (trimmed.length === 0) {
      console.log("[Leads:Search] empty search term", { tenantId });
      return [];
    }
    const effectiveStatus = statusFilter ?? "active";

    const results = await ctx.db
      .query("leads")
      .withSearchIndex("search_leads", (q) =>
        q
          .search("searchText", trimmed)
          .eq("tenantId", tenantId)
          .eq("status", effectiveStatus),
      )
      .take(20);

    console.log("[Leads:Search] searchLeads completed", {
      tenantId,
      searchTerm: trimmed,
      statusFilter: effectiveStatus,
      resultCount: results.length,
    });

    return results;
  },
});

export const getLeadDetail = query({
  args: {
    leadId: v.id("leads"),
  },
  handler: async (ctx, { leadId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const lead = await ctx.db.get(leadId);
    if (!lead || lead.tenantId !== tenantId) {
      throw new Error("Lead not found");
    }

    if (lead.status === "merged" && lead.mergedIntoLeadId) {
      const targetLead = await ctx.db.get(lead.mergedIntoLeadId);
      if (targetLead && targetLead.tenantId === tenantId) {
        console.log("[Leads:Detail] merged lead redirect", {
          sourceLeadId: leadId,
          targetLeadId: targetLead._id,
        });
        return {
          redirectToLeadId: targetLead._id,
          lead: null,
          identifiers: [],
          opportunities: [],
          meetings: [],
          followUps: [],
          mergeHistory: [],
          potentialDuplicates: [],
        };
      }

      console.error("[Leads:Detail] broken merged lead redirect", {
        sourceLeadId: leadId,
        mergedIntoLeadId: lead.mergedIntoLeadId,
      });
    }

    const [
      identifiers,
      rawOpportunities,
      followUps,
      mergeHistoryAsSource,
      mergeHistoryAsTarget,
    ] = await Promise.all([
      ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
        .order("desc")
        .take(100),
      ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", leadId),
        )
        .order("desc")
        .take(50),
      ctx.db
        .query("followUps")
        .withIndex("by_tenantId_and_leadId_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", leadId),
        )
        .order("desc")
        .take(50),
      ctx.db
        .query("leadMergeHistory")
        .withIndex("by_sourceLeadId", (q) => q.eq("sourceLeadId", leadId))
        .take(20),
      ctx.db
        .query("leadMergeHistory")
        .withIndex("by_targetLeadId", (q) => q.eq("targetLeadId", leadId))
        .take(20),
    ]);

    const closerIds = new Set<Id<"users">>();
    const eventTypeConfigIds = new Set<Id<"eventTypeConfigs">>();
    for (const opportunity of rawOpportunities) {
      if (opportunity.assignedCloserId) {
        closerIds.add(opportunity.assignedCloserId);
      }
      if (opportunity.eventTypeConfigId) {
        eventTypeConfigIds.add(opportunity.eventTypeConfigId);
      }
    }

    const [closers, eventTypes] = await Promise.all([
      Promise.all(
        [...closerIds].map(async (closerId) => ({
          closerId,
          closer: await ctx.db.get(closerId),
        })),
      ),
      Promise.all(
        [...eventTypeConfigIds].map(async (eventTypeConfigId) => ({
          eventTypeConfigId,
          eventType: await ctx.db.get(eventTypeConfigId),
        })),
      ),
    ]);

    const closerById = new Map<Id<"users">, string | null>(
      closers.map(({ closerId, closer }) => [
        closerId,
        closer && closer.tenantId === tenantId
          ? closer.fullName ?? closer.email
          : null,
      ]),
    );

    const eventTypeById = new Map<Id<"eventTypeConfigs">, string | null>(
      eventTypes.map(({ eventTypeConfigId, eventType }) => [
        eventTypeConfigId,
        eventType?.displayName ?? null,
      ]),
    );

    const opportunities: LeadDetailOpportunity[] = rawOpportunities.map(
      (opportunity) => ({
        ...opportunity,
        closerName: opportunity.assignedCloserId
          ? closerById.get(opportunity.assignedCloserId) ?? null
          : null,
        eventTypeName: opportunity.eventTypeConfigId
          ? eventTypeById.get(opportunity.eventTypeConfigId) ?? null
          : null,
      }),
    );

    const meetingsByOpportunity = await Promise.all(
      opportunities.map(async (opportunity) => {
        const opportunityMeetings = await ctx.db
          .query("meetings")
          .withIndex("by_opportunityId", (q) =>
            q.eq("opportunityId", opportunity._id),
          )
          .order("desc")
          .take(50);

        return opportunityMeetings.map(
          (meeting): LeadDetailMeeting => ({
            ...meeting,
            opportunityStatus: opportunity.status,
            closerName: opportunity.closerName,
          }),
        );
      }),
    );

    const meetings = meetingsByOpportunity
      .flat()
      .sort((a, b) => b.scheduledAt - a.scheduledAt);

    const rawMergeHistory = [...mergeHistoryAsSource, ...mergeHistoryAsTarget].sort(
      (a, b) => b.mergedAt - a.mergedAt,
    );

    const mergeUserIds = new Set<Id<"users">>();
    const mergeLeadIds = new Set<Id<"leads">>();
    for (const entry of rawMergeHistory) {
      mergeUserIds.add(entry.mergedByUserId);
      mergeLeadIds.add(entry.sourceLeadId);
      mergeLeadIds.add(entry.targetLeadId);
    }

    const [mergeUsers, mergeLeads] = await Promise.all([
      Promise.all(
        [...mergeUserIds].map(async (userId) => ({
          userId,
          user: await ctx.db.get(userId),
        })),
      ),
      Promise.all(
        [...mergeLeadIds].map(async (mergeLeadId) => ({
          mergeLeadId,
          mergeLead:
            mergeLeadId === leadId ? lead : await ctx.db.get(mergeLeadId),
        })),
      ),
    ]);

    const mergeUserById = new Map<Id<"users">, string>(
      mergeUsers.map(({ userId, user }) => [userId, getDisplayName(user)]),
    );

    const mergeLeadById = new Map<
      Id<"leads">,
      Pick<Doc<"leads">, "fullName" | "email"> | null
    >(mergeLeads.map(({ mergeLeadId, mergeLead }) => [mergeLeadId, mergeLead]));

    const mergeHistory: LeadMergeHistoryEntry[] = rawMergeHistory.map((entry) => ({
      ...entry,
      mergedByUserName: mergeUserById.get(entry.mergedByUserId) ?? "Unknown",
      sourceLeadName: getDisplayName(
        mergeLeadById.get(entry.sourceLeadId) ?? null,
      ),
      targetLeadName: getDisplayName(
        mergeLeadById.get(entry.targetLeadId) ?? null,
      ),
    }));

    // Resolve potential duplicate leads flagged on any opportunity
    const duplicateLeadIds = new Set<Id<"leads">>();
    const duplicateOpportunityMap = new Map<string, Id<"opportunities">>();
    for (const opp of opportunities) {
      if (opp.potentialDuplicateLeadId && opp.potentialDuplicateLeadId !== leadId) {
        const dupIdStr = opp.potentialDuplicateLeadId as string;
        duplicateLeadIds.add(opp.potentialDuplicateLeadId);
        // Track the first opportunity that flags this duplicate
        if (!duplicateOpportunityMap.has(dupIdStr)) {
          duplicateOpportunityMap.set(dupIdStr, opp._id);
        }
      }
    }

    const potentialDuplicates: Array<{
      duplicateLead: { _id: Id<"leads">; fullName?: string; email: string };
      opportunityId: Id<"opportunities">;
    }> = [];

    const duplicateLeads = await Promise.all(
      [...duplicateLeadIds].map(async (dupLeadId) => ({
        dupLeadId,
        dupLead: await ctx.db.get(dupLeadId),
      })),
    );

    for (const { dupLeadId, dupLead } of duplicateLeads) {
      if (dupLead && dupLead.tenantId === tenantId) {
        const oppId = duplicateOpportunityMap.get(dupLeadId as string);
        if (oppId) {
          potentialDuplicates.push({
            duplicateLead: {
              _id: dupLead._id,
              fullName: dupLead.fullName,
              email: dupLead.email,
            },
            opportunityId: oppId,
          });
        }
      }
    }

    console.log("[Leads:Detail] getLeadDetail completed", {
      leadId,
      identifierCount: identifiers.length,
      opportunityCount: opportunities.length,
      meetingCount: meetings.length,
      followUpCount: followUps.length,
      mergeHistoryCount: mergeHistory.length,
      potentialDuplicateCount: potentialDuplicates.length,
    });

    return {
      redirectToLeadId: null,
      lead,
      identifiers,
      opportunities,
      meetings,
      followUps,
      mergeHistory,
      potentialDuplicates,
    };
  },
});

export const getMergePreview = query({
  args: {
    sourceLeadId: v.id("leads"),
    targetLeadId: v.id("leads"),
  },
  handler: async (ctx, { sourceLeadId, targetLeadId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    if (sourceLeadId === targetLeadId) {
      throw new Error("Cannot merge a lead into itself");
    }

    const source = await ctx.db.get(sourceLeadId);
    const target = await ctx.db.get(targetLeadId);

    if (!source || source.tenantId !== tenantId) {
      throw new Error("Source lead not found");
    }
    if (!target || target.tenantId !== tenantId) {
      throw new Error("Target lead not found");
    }
    if (source.status !== "active") {
      throw new Error(`Source lead cannot be merged from status "${source.status}"`);
    }
    if (target.status !== "active") {
      throw new Error(`Target lead cannot receive a merge from status "${target.status}"`);
    }

    const [sourceIdentifiers, targetIdentifiers, sourceOpportunities, targetOpportunities] =
      await Promise.all([
        ctx.db
          .query("leadIdentifiers")
          .withIndex("by_leadId", (q) => q.eq("leadId", sourceLeadId))
          .take(100),
        ctx.db
          .query("leadIdentifiers")
          .withIndex("by_leadId", (q) => q.eq("leadId", targetLeadId))
          .take(100),
        ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_leadId", (q) =>
            q.eq("tenantId", tenantId).eq("leadId", sourceLeadId),
          )
          .take(50),
        ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_leadId", (q) =>
            q.eq("tenantId", tenantId).eq("leadId", targetLeadId),
          )
          .take(50),
      ]);

    const targetIdentifierKeys = new Set(
      targetIdentifiers.map((identifier) => `${identifier.type}:${identifier.value}`),
    );

    const identifiersToMove = sourceIdentifiers.filter(
      (identifier) =>
        !targetIdentifierKeys.has(`${identifier.type}:${identifier.value}`),
    );
    const duplicateIdentifiers = sourceIdentifiers.filter((identifier) =>
      targetIdentifierKeys.has(`${identifier.type}:${identifier.value}`),
    );

    console.log("[Leads:MergePreview] getMergePreview completed", {
      sourceLeadId,
      targetLeadId,
      sourceIdentifierCount: sourceIdentifiers.length,
      targetIdentifierCount: targetIdentifiers.length,
      identifiersToMove: identifiersToMove.length,
      duplicateIdentifiers: duplicateIdentifiers.length,
      sourceOpportunityCount: sourceOpportunities.length,
      targetOpportunityCount: targetOpportunities.length,
    });

    return {
      source: {
        lead: source,
        identifiers: sourceIdentifiers,
        opportunityCount: sourceOpportunities.length,
      },
      target: {
        lead: target,
        identifiers: targetIdentifiers,
        opportunityCount: targetOpportunities.length,
      },
      preview: {
        identifiersToMove: identifiersToMove.length,
        duplicateIdentifiers: duplicateIdentifiers.length,
        opportunitiesToMove: sourceOpportunities.length,
        totalOpportunitiesAfterMerge:
          sourceOpportunities.length + targetOpportunities.length,
      },
    };
  },
});
