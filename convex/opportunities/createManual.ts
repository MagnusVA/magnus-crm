import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { resolveLeadIdentity } from "../leads/identityResolution";
import { requireTenantUser } from "../requireTenantUser";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { newLeadInputValidator } from "./validators";

type NewLeadInput = {
  fullName: string;
  email: string;
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

function leadDisplayName(lead: Doc<"leads">): string {
  return lead.fullName ?? lead.email;
}

function assertLeadCanStartManualSideDeal(lead: Doc<"leads">): void {
  if (lead.status !== "active") {
    throw new Error(
      `Lead "${leadDisplayName(lead)}" is ${lead.status}. Only active leads can be used for a new side-deal opportunity.`,
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
    const lead = await ctx.db.get(args.existingLeadId);
    if (!lead || lead.tenantId !== args.tenantId) {
      throw new Error("Selected lead not found.");
    }
    if (lead.status === "merged" && lead.mergedIntoLeadId) {
      const target = await ctx.db.get(lead.mergedIntoLeadId);
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

  const result = await resolveLeadIdentity(ctx, {
    tenantId: args.tenantId,
    fullName: args.newLeadInput.fullName,
    email: args.newLeadInput.email,
    phone: args.newLeadInput.phone,
    socialHandle: args.newLeadInput.socialHandle,
    identifierSource: "side_deal",
    createdAt: args.now,
    createIdentifiers: true,
  });

  if (!result.created) {
    const resolvedLead = result.lead;
    const resolvedBy =
      result.resolvedVia === "social_handle"
        ? "social handle"
        : result.resolvedVia;
    if (resolvedLead.status !== "active") {
      throw new Error(
        `This ${resolvedBy} belongs to ${resolvedLead.status} lead "${leadDisplayName(resolvedLead)}". Only active leads can be used for a new side-deal opportunity.`,
      );
    }
    throw new Error(
      `This ${resolvedBy} already belongs to "${leadDisplayName(resolvedLead)}". Use Existing lead, or enter different lead details.`,
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
      const closer = await ctx.db.get(args.assignedCloserId);
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
      status: "in_progress",
      source: "side_deal",
      manualCreationKey,
      notes,
      createdAt: now,
      updatedAt: now,
      latestActivityAt: now,
    });

    await insertOpportunityAggregate(ctx, opportunityId);
    await updateTenantStats(ctx, tenantId, {
      totalOpportunities: 1,
      activeOpportunities: 1,
    });

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
      toStatus: "in_progress",
      occurredAt: now,
      metadata: { source: "side_deal", assignedCloserId },
    });

    return { opportunityId, leadId, leadWasCreated };
  },
});
