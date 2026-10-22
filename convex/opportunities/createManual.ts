import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { recordDealCreation } from "../lib/attribution/dealAttributions";
import { emitDomainEvent } from "../lib/domainEvents";
import { recordOpportunity } from "../lib/leadLifecycle";
import {
  isPlaceholderEmail,
  normalizeEmail,
  normalizePhone,
  normalizeSocialHandle,
} from "../lib/normalization";
import { rejectRequest } from "../lib/observability/errors";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { resolveLeadIdentity } from "../leads/identityResolution";
import { requireTenantUser } from "../requireTenantUser";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { newDealStageFields } from "./dealState";
import { newLeadInputValidator } from "./validators";

type NewLeadInput = {
  fullName: string;
  email?: string;
  phone?: string;
  socialHandle?: {
    platform:
      | "instagram"
      | "tiktok"
      | "twitter"
      | "facebook"
      | "linkedin"
      | "other_social";
    handle: string;
  };
};

// A customer can buy a second program, so converted leads qualify; a merged
// lead lives on as its target. Messages reach the browser, so they name the
// lead's status, never the lead.
function assertLeadCanStartManualSideDeal(lead: Doc<"leads">): void {
  if (lead.status === "merged") {
    throw rejectRequest(
      "opportunity.lead_not_active",
      `This lead is ${lead.status}. Only active leads and customers can be used for a new side-deal opportunity.`,
      { tenantId: lead.tenantId, leadId: lead._id, leadStatus: lead.status },
    );
  }
}

async function resolveLeadForManualCreate(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    existingLeadId?: Id<"leads">;
    newLeadInput?: NewLeadInput;
    now: number;
  },
): Promise<{ leadId: Id<"leads">; leadWasCreated: boolean }> {
  if (args.existingLeadId) {
    const lead = await ctx.db.get("leads", args.existingLeadId);
    if (!lead || lead.tenantId !== args.tenantId) {
      throw new Error("Selected lead not found.");
    }
    if (lead.status === "merged" && lead.mergedIntoLeadId) {
      const target = await ctx.db.get("leads", lead.mergedIntoLeadId);
      if (
        !target ||
        target.tenantId !== args.tenantId ||
        target.status === "merged"
      ) {
        throw new Error(
          "Selected lead has been merged but the target lead is unavailable.",
        );
      }
      assertLeadCanStartManualSideDeal(target);
      return { leadId: target._id, leadWasCreated: false };
    }
    assertLeadCanStartManualSideDeal(lead);
    return { leadId: lead._id, leadWasCreated: false };
  }

  if (!args.newLeadInput) {
    throw new Error("New lead input is required.");
  }

  // A placeholder never becomes the lead's email, so one typed in is refused
  // rather than dropped.
  const { email, phone, socialHandle } = args.newLeadInput;
  const normalizedEmail = email ? normalizeEmail(email) : undefined;
  if (normalizedEmail && isPlaceholderEmail(normalizedEmail)) {
    throw rejectRequest(
      "opportunity.placeholder_email",
      "Enter the lead's real email address. A placeholder such as email@gmail.com can't identify a lead.",
      { tenantId: args.tenantId },
    );
  }
  // The person needs no email to become a customer, but needs something that
  // identifies them (docs/plans/phase-4-customers.md D8). A placeholder phone
  // or handle identifies no one, so it doesn't count.
  const hasIdentifier =
    normalizedEmail !== undefined ||
    (phone !== undefined && normalizePhone(phone) !== undefined) ||
    (socialHandle !== undefined &&
      normalizeSocialHandle(socialHandle.handle, socialHandle.platform) !== undefined);
  if (!hasIdentifier) {
    throw rejectRequest(
      "opportunity.identifier_required",
      "Enter the lead's email, phone number or social handle. At least one is needed to identify them.",
      { tenantId: args.tenantId },
    );
  }

  const result = await resolveLeadIdentity(ctx, {
    tenantId: args.tenantId,
    fullName: args.newLeadInput.fullName,
    email,
    phone,
    socialHandle,
    identifierSource: "side_deal",
    createdAt: args.now,
    createIdentifiers: true,
    initialLifecycle: { stage: "showed", at: args.now },
  });

  if (!result.created) {
    const resolvedLead = result.lead;
    const resolvedBy =
      result.resolvedVia === "social_handle"
        ? "social handle"
        : result.resolvedVia;
    const rejectionAttrs = {
      tenantId: args.tenantId,
      leadId: resolvedLead._id,
      leadStatus: resolvedLead.status,
      resolvedVia: result.resolvedVia,
    };
    if (resolvedLead.status === "merged") {
      throw rejectRequest(
        "opportunity.lead_not_active",
        `This ${resolvedBy} belongs to a ${resolvedLead.status} lead. Only active leads and customers can be used for a new side-deal opportunity.`,
        rejectionAttrs,
      );
    }
    throw rejectRequest(
      "opportunity.lead_already_exists",
      `This ${resolvedBy} already belongs to an existing lead. Use Existing lead, or enter different lead details.`,
      rejectionAttrs,
    );
  }

  assertLeadCanStartManualSideDeal(result.lead);
  return { leadId: result.leadId, leadWasCreated: result.created };
}

export const createManual = mutation({
  args: {
    clientRequestId: v.string(),
    existingLeadId: v.optional(v.id("leads")),
    newLeadInput: v.optional(newLeadInputValidator),
    assignedCloserId: v.optional(v.id("users")),
    notes: v.optional(v.string()),
  },
  returns: v.object({
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    leadWasCreated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const isAdmin = role === "tenant_master" || role === "tenant_admin";
    const manualCreationKey = args.clientRequestId.trim();

    if (!manualCreationKey || manualCreationKey.length > 100) {
      throw new Error("Invalid creation request ID.");
    }

    const existingByRequest = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_manualCreationKey", (q) =>
        q.eq("tenantId", tenantId).eq("manualCreationKey", manualCreationKey),
      )
      .unique();
    if (existingByRequest) {
      return {
        opportunityId: existingByRequest._id,
        leadId: existingByRequest.leadId,
        leadWasCreated: false,
      };
    }

    const hasExistingLead = args.existingLeadId !== undefined;
    const hasNewLeadInput = args.newLeadInput !== undefined;
    if (hasExistingLead === hasNewLeadInput) {
      throw new Error("Provide either existingLeadId or newLeadInput.");
    }

    let assignedCloserId: Id<"users">;
    if (isAdmin) {
      if (!args.assignedCloserId) {
        throw new Error("Pick an active closer before creating an opportunity.");
      }
      const closer = await ctx.db.get("users", args.assignedCloserId);
      if (
        !closer ||
        closer.tenantId !== tenantId ||
        closer.role !== "closer" ||
        closer.isActive === false
      ) {
        throw new Error("Assigned closer not found or inactive in this tenant.");
      }
      assignedCloserId = closer._id;
    } else {
      if (args.assignedCloserId && args.assignedCloserId !== userId) {
        throw new Error("Only admins can create opportunities on behalf of another closer.");
      }
      assignedCloserId = userId;
    }

    const { leadId, leadWasCreated } = await resolveLeadForManualCreate(ctx, {
      tenantId,
      existingLeadId: args.existingLeadId,
      newLeadInput: args.newLeadInput,
      now,
    });

    const notes = args.notes?.trim() || undefined;
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      assignedCloserId,
      source: "side_deal",
      ...newDealStageFields("call_held"),
      manualCreationKey,
      notes,
      createdAt: now,
      updatedAt: now,
      latestActivityAt: now,
    });

    await insertOpportunityAggregate(ctx, opportunityId);
    await updateTenantStats(ctx, tenantId, { totalOpportunities: 1 });
    await recordOpportunity(ctx, opportunityId);

    if (leadWasCreated) {
      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "lead",
        entityId: leadId,
        eventType: "lead.created",
        source: isAdmin ? "admin" : "closer",
        actorUserId: userId,
        toStatus: "active",
        occurredAt: now,
        metadata: { source: "side_deal" },
      });
    }

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.created",
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      // The stage it starts at (docs/plans/phase-5-deal-status.md §4.7).
      toStatus: "call_held",
      occurredAt: now,
      metadata: { source: "side_deal", assignedCloserId, toOutcome: "open" },
    });
    await recordDealCreation(ctx, opportunityId);

    return { opportunityId, leadId, leadWasCreated };
  },
});
