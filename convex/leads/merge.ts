import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { buildLeadSearchText } from "./searchTextBuilder";
import { emitDomainEvent } from "../lib/domainEvents";
import { refreshOpportunitySearchForLead } from "../lib/opportunitySearch";
import { syncCustomerSnapshot } from "../lib/syncCustomerSnapshot";
import { syncLeadMeetingNames } from "../lib/syncLeadMeetingNames";

const SOCIAL_IDENTIFIER_TYPES = new Set<Doc<"leadIdentifiers">["type"]>([
  "instagram",
  "tiktok",
  "twitter",
  "facebook",
  "linkedin",
  "other_social",
]);

function isActiveLikeLeadStatus(status: Doc<"leads">["status"]): boolean {
  return status === "active";
}

function buildSocialHandles(
  identifiers: Doc<"leadIdentifiers">[],
): NonNullable<Doc<"leads">["socialHandles"]> | undefined {
  const seen = new Set<string>();
  const handles: NonNullable<Doc<"leads">["socialHandles"]> = [];

  for (const identifier of identifiers) {
    if (!SOCIAL_IDENTIFIER_TYPES.has(identifier.type)) {
      continue;
    }

    const key = `${identifier.type}:${identifier.value}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    handles.push({
      type: identifier.type,
      handle: identifier.value,
    });
  }

  return handles.length > 0 ? handles : undefined;
}

async function countMeetingsForOpportunities(
  ctx: MutationCtx,
  opportunities: Doc<"opportunities">[],
): Promise<number> {
  let count = 0;

  for (const opportunity of opportunities) {
    for await (const meeting of ctx.db
      .query("meetings")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", opportunity._id),
      )) {
      void meeting;
      count += 1;
    }
  }

  return count;
}

export const mergeLead = mutation({
  args: {
    sourceLeadId: v.id("leads"),
    targetLeadId: v.id("leads"),
  },
  handler: async (ctx, { sourceLeadId, targetLeadId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    await executeMerge(ctx, tenantId, userId, sourceLeadId, targetLeadId);

    return { targetLeadId };
  },
});

async function executeMerge(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  userId: Id<"users">,
  sourceLeadId: Id<"leads">,
  targetLeadId: Id<"leads">,
): Promise<void> {
  const now = Date.now();

  if (sourceLeadId === targetLeadId) {
    throw new Error("Cannot merge a lead with itself");
  }

  const sourceLead = await ctx.db.get(sourceLeadId);
  const targetLead = await ctx.db.get(targetLeadId);

  if (!sourceLead || sourceLead.tenantId !== tenantId) {
    throw new Error("Source lead not found");
  }
  if (!targetLead || targetLead.tenantId !== tenantId) {
    throw new Error("Target lead not found");
  }
  if (!isActiveLikeLeadStatus(sourceLead.status)) {
    throw new Error(
      `Source lead cannot be merged from status "${sourceLead.status}"`,
    );
  }
  if (!isActiveLikeLeadStatus(targetLead.status)) {
    throw new Error(
      `Target lead cannot receive a merge from status "${targetLead.status}"`,
    );
  }

  const sourceOpportunities = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", sourceLeadId),
    )
    .take(100);
  const meetingsMoved = await countMeetingsForOpportunities(
    ctx,
    sourceOpportunities,
  );

  for (const opportunity of sourceOpportunities) {
    await ctx.db.patch(opportunity._id, {
      leadId: targetLeadId,
      potentialDuplicateLeadId: undefined,
      updatedAt: now,
    });
  }

  const sourceIdentifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", sourceLeadId))
    .take(100);
  const targetIdentifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", targetLeadId))
    .take(100);

  const targetIdentifierKeys = new Set(
    targetIdentifiers.map((identifier) => `${identifier.type}:${identifier.value}`),
  );

  let identifiersMoved = 0;
  for (const identifier of sourceIdentifiers) {
    const key = `${identifier.type}:${identifier.value}`;
    if (!targetIdentifierKeys.has(key)) {
      await ctx.db.insert("leadIdentifiers", {
        tenantId,
        leadId: targetLeadId,
        type: identifier.type,
        value: identifier.value,
        rawValue: identifier.rawValue,
        source: "merge",
        sourceMeetingId: identifier.sourceMeetingId,
        confidence: identifier.confidence,
        createdAt: now,
      });
      targetIdentifierKeys.add(key);
      identifiersMoved += 1;
    }

    await ctx.db.delete(identifier._id);
  }

  const allTargetIdentifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", targetLeadId))
    .take(200);
  const socialHandles = buildSocialHandles(allTargetIdentifiers);
  const refreshedTargetLead = await ctx.db.get(targetLeadId);
  if (!refreshedTargetLead) {
    throw new Error("Target lead disappeared during merge");
  }

  const searchText = buildLeadSearchText(
    {
      ...refreshedTargetLead,
      socialHandles,
    },
    allTargetIdentifiers.map((identifier) => identifier.value),
  );

  await ctx.db.patch(targetLeadId, {
    socialHandles,
    searchText,
    updatedAt: now,
  });
  await refreshOpportunitySearchForLead(ctx, tenantId, targetLeadId);
  await syncCustomerSnapshot(ctx, tenantId, targetLeadId);
  await syncLeadMeetingNames(
    ctx,
    tenantId,
    targetLeadId,
    refreshedTargetLead.fullName ?? refreshedTargetLead.email,
  );

  await ctx.db.patch(sourceLeadId, {
    status: "merged",
    mergedIntoLeadId: targetLeadId,
    updatedAt: now,
  });
  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "lead",
    entityId: sourceLeadId,
    eventType: "lead.merged",
    source: "admin",
    actorUserId: userId,
    fromStatus: sourceLead.status,
    toStatus: "merged",
    metadata: {
      targetLeadId,
      identifiersMoved,
      opportunitiesMoved: sourceOpportunities.length,
      meetingsMoved,
    },
    occurredAt: now,
  });

  const tenantOpportunities = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(500);
  for (const opportunity of tenantOpportunities) {
    if (opportunity.potentialDuplicateLeadId !== sourceLeadId) {
      continue;
    }

    await ctx.db.patch(opportunity._id, {
      potentialDuplicateLeadId: undefined,
      updatedAt: now,
    });
  }

  await ctx.db.insert("leadMergeHistory", {
    tenantId,
    sourceLeadId,
    targetLeadId,
    mergedByUserId: userId,
    mergedAt: now,
    identifiersMoved,
    opportunitiesMoved: sourceOpportunities.length,
    meetingsMoved,
  });

  console.log("[Leads:Merge] executeMerge completed", {
    tenantId,
    sourceLeadId,
    targetLeadId,
    identifiersMoved,
    opportunitiesMoved: sourceOpportunities.length,
    meetingsMoved,
    mergedByUserId: userId,
  });
}

export const dismissDuplicateFlag = mutation({
  args: {
    opportunityId: v.id("opportunities"),
  },
  handler: async (ctx, { opportunityId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    await ctx.db.patch(opportunityId, {
      potentialDuplicateLeadId: undefined,
      updatedAt: Date.now(),
    });

    console.log("[Leads:Merge] dismissDuplicateFlag completed", {
      tenantId,
      opportunityId,
    });

    return { opportunityId };
  },
});
