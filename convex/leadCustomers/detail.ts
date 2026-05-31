import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { buildEntityDetailPayload } from "./detailPayload";

export const getEntityDetail = query({
  args: { leadId: v.id("leads") },
  handler: async (ctx, { leadId }) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const lead = await ctx.db.get(leadId);
    if (!lead || lead.tenantId !== tenantId) {
      return null;
    }

    if (lead.status === "merged" && lead.mergedIntoLeadId) {
      const targetLead = await ctx.db.get(lead.mergedIntoLeadId);
      if (!targetLead || targetLead.tenantId !== tenantId) {
        return null;
      }
      return { kind: "redirect" as const, leadId: targetLead._id };
    }

    const [customer, opportunities, identifiers] = await Promise.all([
      ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", leadId),
        )
        .first(),
      ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", leadId),
        )
        .order("desc")
        .take(50),
      ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
        .order("desc")
        .take(100),
    ]);

    return await buildEntityDetailPayload(ctx, {
      tenantId,
      viewerUserId: userId,
      viewerRole: role,
      lead,
      customer,
      identifiers,
      opportunities,
    });
  },
});
