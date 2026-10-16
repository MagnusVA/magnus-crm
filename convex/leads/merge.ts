import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, mutation } from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { requireTenantUser } from "../requireTenantUser";
import { buildLeadSearchText } from "./searchTextBuilder";
import {
  moveFormResponsesPage,
  moveOpportunityToLead,
  moveRemainingLeadRows,
} from "./repointLeadReferences";
import { emitDomainEvent } from "../lib/domainEvents";
import { rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { upsertOpportunitySearchProjection } from "../lib/opportunitySearch";
import { syncCustomerSnapshot } from "../lib/syncCustomerSnapshot";
import { leadDisplayString } from "../lib/leadDisplay";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { rebuildQualificationRow } from "../operations/projections";

// A merge moves all of the source in one transaction, or nothing. At 50
// opportunities, the count the merge preview shows, a merge stays well
// inside Convex's per-transaction read limits (see merge.test.ts).
const MERGE_OPPORTUNITY_LIMIT = 50;
const MERGE_IDENTIFIER_LIMIT = 100;
// Bounds reads that don't decide whether the merge can run: the target's own
// opportunities, meetings, and Slack events, and leads merged into the
// source. A full read is logged as `leads.merge.bound_hit`.
const BOUNDED_READ_LIMIT = 100;
// A lead can have hundreds of form responses, and any number of other
// leads' opportunities can flag it as a duplicate. The merge moves the first
// page of form responses; `continueLeadMerge` moves the rest and clears the
// flags.
const FORM_RESPONSE_PAGE_SIZE = 200;
// Clearing a flag rebuilds its lead's lead/customer row.
const DUPLICATE_FLAG_PAGE_SIZE = 25;

const SOCIAL_IDENTIFIER_TYPES = new Set<Doc<"leadIdentifiers">["type"]>([
  "instagram",
  "tiktok",
  "twitter",
  "facebook",
  "linkedin",
  "other_social",
]);

type ProfileCarryOver = Partial<
  Pick<
    Doc<"leads">,
    | "fullName"
    | "email"
    | "phone"
    | "country"
    | "leadType"
    | "customFields"
    | "customFieldLabels"
    | "initialSource"
    | "selfReportedIncome"
  >
>;

function isActiveLikeLeadStatus(status: Doc<"leads">["status"]): boolean {
  return status === "active";
}

export function buildSocialHandles(
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

function isBlank(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && !value.trim());
}

function carryOverIfMissing<K extends keyof ProfileCarryOver>(
  carryOver: ProfileCarryOver,
  source: Doc<"leads">,
  target: Doc<"leads">,
  field: K,
) {
  if (isBlank(target[field]) && !isBlank(source[field])) {
    carryOver[field] = source[field];
  }
}

function mergeMissingKeys(
  target: Record<string, string> | undefined,
  source: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const missing = Object.entries(source ?? {}).filter(
    ([key]) => target?.[key] === undefined,
  );
  return missing.length > 0
    ? { ...target, ...Object.fromEntries(missing) }
    : undefined;
}

/**
 * The source's profile fields that the target lacks. The target's data wins
 * (the NIM-17 rule for portal fields, applied to every field), and custom
 * fields merge key by key. The email moves only onto a target with none, and
 * only when no other unmerged lead already has it as its canonical email.
 */
async function buildProfileCarryOver(
  ctx: MutationCtx,
  source: Doc<"leads">,
  target: Doc<"leads">,
): Promise<ProfileCarryOver> {
  const carryOver: ProfileCarryOver = {};
  for (const field of [
    "fullName",
    "phone",
    "country",
    "leadType",
    "initialSource",
    "selfReportedIncome",
  ] as const) {
    carryOverIfMissing(carryOver, source, target, field);
  }

  const customFields = mergeMissingKeys(
    target.customFields,
    source.customFields,
  );
  if (customFields) {
    carryOver.customFields = customFields;
  }
  const customFieldLabels = mergeMissingKeys(
    target.customFieldLabels,
    source.customFieldLabels,
  );
  if (customFieldLabels) {
    carryOver.customFieldLabels = customFieldLabels;
  }

  const email = source.email;
  if (email && !isBlank(email) && isBlank(target.email)) {
    const leadsWithEmail = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", source.tenantId).eq("email", email),
      )
      .take(10);
    const usedElsewhere = leadsWithEmail.some(
      (lead) =>
        lead._id !== source._id &&
        lead._id !== target._id &&
        lead.status !== "merged",
    );
    if (!usedElsewhere) {
      carryOver.email = email;
    }
  }

  return carryOver;
}

function duplicateFlagsQuery(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  mergedLeadId: Id<"leads">,
) {
  return ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_potentialDuplicateLeadId", (q) =>
      q.eq("tenantId", tenantId).eq("potentialDuplicateLeadId", mergedLeadId),
    );
}

/**
 * Clears one page of the duplicate flags that name a merged lead, as merges
 * always have. Returns `hasMore` when the page was full.
 */
async function clearDuplicateFlagsPage(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  mergedLeadId: Id<"leads">,
): Promise<{ cleared: number; hasMore: boolean }> {
  const flagged = await duplicateFlagsQuery(ctx, tenantId, mergedLeadId).take(
    DUPLICATE_FLAG_PAGE_SIZE,
  );
  for (const opportunity of flagged) {
    // Keep `updatedAt`: another lead was merged, not this deal.
    await patchOpportunityLifecycle(ctx, opportunity._id, {
      potentialDuplicateLeadId: undefined,
      updatedAt: opportunity.updatedAt,
    });
    // The patch recomputes `latestActivityAt`, which the search row copies.
    await upsertOpportunitySearchProjection(ctx, opportunity._id);
  }
  return {
    cleared: flagged.length,
    hasMore: flagged.length === DUPLICATE_FLAG_PAGE_SIZE,
  };
}

/**
 * Updates what the target's own rows copy from its profile: opportunity
 * search rows (lead search text), meeting `leadName`, and Slack
 * qualification rows (name, email, phone). Runs before the source's rows
 * move onto the target, which keeps those up to date itself.
 */
async function refreshTargetCopies(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    targetLeadId: Id<"leads">;
    leadName: string;
    searchTextChanged: boolean;
    leadNameChanged: boolean;
    contactChanged: boolean;
    boundsHit: string[];
  },
) {
  const { tenantId, targetLeadId, boundsHit } = args;
  if (args.searchTextChanged || args.leadNameChanged) {
    const opportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", targetLeadId),
      )
      .take(BOUNDED_READ_LIMIT);
    if (opportunities.length === BOUNDED_READ_LIMIT) {
      boundsHit.push("target_opportunities");
    }
    for (const opportunity of opportunities) {
      if (args.searchTextChanged) {
        await upsertOpportunitySearchProjection(ctx, opportunity._id);
      }
      if (!args.leadNameChanged) {
        continue;
      }
      const meetings = await ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", opportunity._id),
        )
        .take(BOUNDED_READ_LIMIT);
      if (meetings.length === BOUNDED_READ_LIMIT) {
        boundsHit.push("target_meetings");
      }
      for (const meeting of meetings) {
        if (meeting.leadName !== args.leadName) {
          await ctx.db.patch("meetings", meeting._id, {
            leadName: args.leadName,
          });
        }
      }
    }
  }

  if (args.contactChanged) {
    const events = await ctx.db
      .query("slackQualificationEvents")
      .withIndex("by_tenantId_and_leadId_and_submittedAt", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", targetLeadId),
      )
      .take(BOUNDED_READ_LIMIT);
    if (events.length === BOUNDED_READ_LIMIT) {
      boundsHit.push("target_qualification_events");
    }
    for (const event of events) {
      await rebuildQualificationRow(ctx, event._id);
    }
  }
}

export const mergeLead = mutation({
  args: {
    sourceLeadId: v.id("leads"),
    targetLeadId: v.id("leads"),
  },
  returns: v.object({ targetLeadId: v.id("leads") }),
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

/**
 * The same merge, run from the CLI by an operator on a user's behalf. The
 * user is named as `actorUserId`, checked for the roles `mergeLead` allows,
 * and recorded as the one who merged.
 */
export const mergeLeadAsOperator = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    actorUserId: v.id("users"),
    sourceLeadId: v.id("leads"),
    targetLeadId: v.id("leads"),
  },
  returns: v.object({ targetLeadId: v.id("leads") }),
  handler: async (ctx, { tenantId, actorUserId, sourceLeadId, targetLeadId }) => {
    const actor = await ctx.db.get("users", actorUserId);
    if (
      !actor ||
      actor.tenantId !== tenantId ||
      !actor.isActive ||
      !["tenant_master", "tenant_admin", "closer"].includes(actor.role)
    ) {
      throw new Error("The actor must be an active user who can merge leads");
    }
    await executeMerge(ctx, tenantId, actorUserId, sourceLeadId, targetLeadId);
    return { targetLeadId };
  },
});

/**
 * Puts back a deal's activity time where a merge's own write set it, from
 * before moving a deal to another lead kept `updatedAt`. Acts only on a deal
 * on a merge target whose `updatedAt` is still exactly that merge's time,
 * and only moves it earlier, to no earlier than the deal's creation.
 */
export const restoreMergedActivityTime = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    updatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { tenantId, opportunityId, updatedAt }) => {
    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    const merges = await ctx.db
      .query("leadMergeHistory")
      .withIndex("by_targetLeadId", (q) => q.eq("targetLeadId", opportunity.leadId))
      .take(BOUNDED_READ_LIMIT);
    if (!merges.some((merge) => merge.tenantId === tenantId && merge.mergedAt === opportunity.updatedAt)) {
      throw new Error("The deal's last update isn't a merge's write");
    }
    if (!Number.isFinite(updatedAt)) {
      throw new Error("The restored time must be finite");
    }
    if (updatedAt >= opportunity.updatedAt || updatedAt < opportunity.createdAt) {
      throw new Error("The restored time must be earlier, and no earlier than the deal's creation");
    }
    // Recomputes latestActivityAt and the rows that copy it.
    await patchOpportunityLifecycle(ctx, opportunityId, { updatedAt });
    log.info("leads.merge.activity_restored", {
      tenantId,
      opportunityId,
      from: opportunity.updatedAt,
      to: updatedAt,
    });
    return null;
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

  const sourceLead = await ctx.db.get("leads", sourceLeadId);
  const targetLead = await ctx.db.get("leads", targetLeadId);

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

  // Read one past each bound before writing anything, so a lead too large
  // to move in one transaction is rejected whole instead of moved in part.
  const sourceOpportunities = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", sourceLeadId),
    )
    .take(MERGE_OPPORTUNITY_LIMIT + 1);
  if (sourceOpportunities.length > MERGE_OPPORTUNITY_LIMIT) {
    throw rejectRequest(
      "lead.merge_too_many_opportunities",
      `This lead has more than ${MERGE_OPPORTUNITY_LIMIT} opportunities, which is more than one merge can move. Nothing was merged.`,
      { tenantId, sourceLeadId, targetLeadId },
    );
  }
  const sourceIdentifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", sourceLeadId))
    .take(MERGE_IDENTIFIER_LIMIT + 1);
  if (sourceIdentifiers.length > MERGE_IDENTIFIER_LIMIT) {
    throw rejectRequest(
      "lead.merge_too_many_identifiers",
      `This lead has more than ${MERGE_IDENTIFIER_LIMIT} identifiers, which is more than one merge can move. Nothing was merged.`,
      { tenantId, sourceLeadId, targetLeadId },
    );
  }

  const boundsHit: string[] = [];
  const targetIdentifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", targetLeadId))
    .take(MERGE_IDENTIFIER_LIMIT);
  if (targetIdentifiers.length === MERGE_IDENTIFIER_LIMIT) {
    boundsHit.push("target_identifiers");
  }

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

    await ctx.db.delete("leadIdentifiers", identifier._id);
  }

  // Update the target's profile first, so every row rebuilt below sees it.
  const carryOver = await buildProfileCarryOver(ctx, sourceLead, targetLead);
  const allTargetIdentifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", targetLeadId))
    .take(2 * MERGE_IDENTIFIER_LIMIT);
  if (allTargetIdentifiers.length === 2 * MERGE_IDENTIFIER_LIMIT) {
    boundsHit.push("all_target_identifiers");
  }
  const socialHandles = buildSocialHandles(allTargetIdentifiers);
  const updatedTargetLead = { ...targetLead, ...carryOver, socialHandles };
  const searchText = buildLeadSearchText(
    updatedTargetLead,
    allTargetIdentifiers.map((identifier) => identifier.value),
  );
  await ctx.db.patch("leads", targetLeadId, {
    ...carryOver,
    socialHandles,
    searchText,
    updatedAt: now,
  });
  const leadName = leadDisplayString(updatedTargetLead, allTargetIdentifiers);
  await refreshTargetCopies(ctx, {
    tenantId,
    targetLeadId,
    leadName,
    searchTextChanged: searchText !== targetLead.searchText,
    leadNameChanged:
      leadName !== leadDisplayString(targetLead, targetIdentifiers),
    contactChanged:
      carryOver.fullName !== undefined ||
      carryOver.email !== undefined ||
      carryOver.phone !== undefined,
    boundsHit,
  });

  const moved = {
    meetings: 0,
    followUps: 0,
    qualificationEvents: 0,
    auditMatches: 0,
    webhookDeliveries: 0,
  };
  for (const opportunity of sourceOpportunities) {
    const result = await moveOpportunityToLead(ctx, {
      tenantId,
      opportunityId: opportunity._id,
      toLeadId: targetLeadId,
      leadName,
      now,
      moveFormResponses: false,
    });
    moved.meetings += result.meetings;
    moved.followUps += result.followUps;
    moved.qualificationEvents += result.qualificationEvents;
    moved.auditMatches += result.auditMatches;
    moved.webhookDeliveries += result.webhookDeliveries;
    boundsHit.push(...result.boundsHit.map((name) => `opportunity_${name}`));
  }
  const leadRows = await moveRemainingLeadRows(ctx, {
    tenantId,
    fromLeadId: sourceLeadId,
    toLeadId: targetLeadId,
    now,
  });
  boundsHit.push(...leadRows.boundsHit.map((name) => `lead_${name}`));
  const formResponses = await moveFormResponsesPage(ctx, {
    tenantId,
    fromLeadId: sourceLeadId,
    toLeadId: targetLeadId,
    limit: FORM_RESPONSE_PAGE_SIZE,
  });

  await ctx.db.patch("leads", sourceLeadId, {
    status: "merged",
    mergedIntoLeadId: targetLeadId,
    updatedAt: now,
  });
  // `totalLeads` counts active leads, and the source was active.
  await updateTenantStats(ctx, tenantId, { totalLeads: -1 });

  // Leads merged into the source now point at the target, so merge chains
  // stay one hop deep. Identity resolution follows at most five.
  const earlierMerges = await ctx.db
    .query("leadMergeHistory")
    .withIndex("by_targetLeadId", (q) => q.eq("targetLeadId", sourceLeadId))
    .take(BOUNDED_READ_LIMIT);
  if (earlierMerges.length === BOUNDED_READ_LIMIT) {
    boundsHit.push("earlier_merges");
  }
  let earlierMergesRepointed = 0;
  for (const entry of earlierMerges) {
    const mergedLead = await ctx.db.get("leads", entry.sourceLeadId);
    if (
      !mergedLead ||
      mergedLead.tenantId !== tenantId ||
      mergedLead.mergedIntoLeadId !== sourceLeadId
    ) {
      continue;
    }
    await ctx.db.patch("leads", mergedLead._id, {
      mergedIntoLeadId: targetLeadId,
    });
    earlierMergesRepointed += 1;
  }

  // The customer snapshot copies the target's profile, and the target's
  // search row reads the customer.
  await syncCustomerSnapshot(ctx, tenantId, targetLeadId);
  await rebuildLeadCustomerSearchRow(ctx, tenantId, targetLeadId);
  await rebuildLeadCustomerSearchRow(ctx, tenantId, sourceLeadId);

  const hasDuplicateFlags =
    (await duplicateFlagsQuery(ctx, tenantId, sourceLeadId).first()) !== null;
  const continues = formResponses.hasMore || hasDuplicateFlags;
  if (continues) {
    await ctx.scheduler.runAfter(0, internal.leads.merge.continueLeadMerge, {
      tenantId,
      sourceLeadId,
      targetLeadId,
    });
  }

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
      meetingsMoved: moved.meetings,
      followUpsMoved: moved.followUps + leadRows.followUps,
      qualificationEventsMoved:
        moved.qualificationEvents + leadRows.qualificationEvents,
      auditMatchesMoved: moved.auditMatches + leadRows.auditMatches,
      webhookDeliveriesMoved: moved.webhookDeliveries,
      notesMoved: leadRows.notes,
      portalEditsMoved: leadRows.portalEdits,
      formResponsesMoved: formResponses.moved,
      earlierMergesRepointed,
      fieldsCarriedOver: Object.keys(carryOver).length,
      continuesInBackground: continues,
    },
    occurredAt: now,
  });

  await ctx.db.insert("leadMergeHistory", {
    tenantId,
    sourceLeadId,
    targetLeadId,
    mergedByUserId: userId,
    mergedAt: now,
    identifiersMoved,
    opportunitiesMoved: sourceOpportunities.length,
    meetingsMoved: moved.meetings,
  });

  // A full read skipped any rows past its bound.
  if (boundsHit.length > 0) {
    log.warn("leads.merge.bound_hit", {
      tenantId,
      sourceLeadId,
      targetLeadId,
      boundsHit: [...new Set(boundsHit)],
    });
  }
}

/**
 * Finishes a merge: moves one more page of the source's form responses and
 * clears one page of the duplicate flags naming it, then schedules itself
 * while either page was full. A run that finds nothing left does nothing.
 */
export const continueLeadMerge = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    sourceLeadId: v.id("leads"),
    targetLeadId: v.id("leads"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { tenantId, sourceLeadId } = args;
    const source = await ctx.db.get("leads", sourceLeadId);
    if (
      !source ||
      source.tenantId !== tenantId ||
      source.status !== "merged" ||
      !source.mergedIntoLeadId
    ) {
      log.warn("leads.merge.continuation_skipped", {
        ...args,
        reason: "source_not_merged",
      });
      return null;
    }

    // The target may have been merged into another lead since, which also
    // repoints the source's `mergedIntoLeadId`.
    let target = await ctx.db.get("leads", source.mergedIntoLeadId);
    for (
      let hops = 0;
      target?.status === "merged" && target.mergedIntoLeadId && hops < 5;
      hops += 1
    ) {
      target = await ctx.db.get("leads", target.mergedIntoLeadId);
    }
    if (!target || target.tenantId !== tenantId || target.status === "merged") {
      log.warn("leads.merge.continuation_skipped", {
        ...args,
        reason: "target_unresolved",
      });
      return null;
    }

    const formResponses = await moveFormResponsesPage(ctx, {
      tenantId,
      fromLeadId: sourceLeadId,
      toLeadId: target._id,
      limit: FORM_RESPONSE_PAGE_SIZE,
    });
    const duplicateFlags = await clearDuplicateFlagsPage(
      ctx,
      tenantId,
      sourceLeadId,
    );
    const continues = formResponses.hasMore || duplicateFlags.hasMore;
    log.info("leads.merge.continued", {
      ...args,
      resolvedTargetLeadId: target._id,
      formResponsesMoved: formResponses.moved,
      duplicateFlagsCleared: duplicateFlags.cleared,
      continues,
    });
    if (continues) {
      await ctx.scheduler.runAfter(
        0,
        internal.leads.merge.continueLeadMerge,
        args,
      );
    }
    return null;
  },
});

export const dismissDuplicateFlag = mutation({
  args: {
    opportunityId: v.id("opportunities"),
  },
  returns: v.object({ opportunityId: v.id("opportunities") }),
  handler: async (ctx, { opportunityId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    await ctx.db.patch("opportunities", opportunityId, {
      potentialDuplicateLeadId: undefined,
      updatedAt: Date.now(),
    });

    return { opportunityId };
  },
});
