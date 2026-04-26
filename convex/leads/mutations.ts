import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { normalizeEmail } from "../lib/normalization";
import { refreshOpportunitySearchForLead } from "../lib/opportunitySearch";
import { requireTenantUser } from "../requireTenantUser";
import { syncCustomerSnapshot } from "../lib/syncCustomerSnapshot";
import { syncLeadMeetingNames } from "../lib/syncLeadMeetingNames";
import { buildLeadSearchText } from "./searchTextBuilder";

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export const updateLead = mutation({
  args: {
    leadId: v.id("leads"),
    fullName: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, { leadId, fullName, phone, email }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const lead = await ctx.db.get(leadId);
    if (!lead || lead.tenantId !== tenantId) {
      throw new Error("Lead not found");
    }
    if (lead.status === "merged") {
      throw new Error("Cannot edit a merged lead");
    }

    const patch: Partial<Doc<"leads">> = {
      updatedAt: Date.now(),
    };

    if (fullName !== undefined) {
      patch.fullName = normalizeOptionalText(fullName);
    }
    if (phone !== undefined) {
      patch.phone = normalizeOptionalText(phone);
    }
    if (email !== undefined) {
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail) {
        throw new Error("Invalid email");
      }
      patch.email = normalizedEmail;
    }

    await ctx.db.patch(leadId, patch);

    const updatedLead = await ctx.db.get(leadId);
    if (!updatedLead) {
      throw new Error("Lead not found after update");
    }

    const identifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
      .take(100);
    const searchText = buildLeadSearchText(
      updatedLead,
      identifiers.map((identifier) => identifier.value),
    );

    if (searchText !== updatedLead.searchText) {
      await ctx.db.patch(leadId, { searchText });
      await refreshOpportunitySearchForLead(ctx, tenantId, leadId);
    }

    await syncCustomerSnapshot(ctx, tenantId, leadId);
    await syncLeadMeetingNames(
      ctx,
      tenantId,
      leadId,
      updatedLead.fullName ?? updatedLead.email,
    );

    console.log("[Leads:Mutation] updateLead completed", {
      leadId,
      updatedFields: [
        fullName !== undefined ? "fullName" : null,
        phone !== undefined ? "phone" : null,
        email !== undefined ? "email" : null,
      ].filter(Boolean),
    });

    return { leadId };
  },
});
