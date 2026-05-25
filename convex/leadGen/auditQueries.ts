import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getProspectAuditDetail = query({
  args: {
    prospectId: v.id("leadGenProspects"),
  },
  handler: async (ctx, { prospectId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const prospect = await ctx.db.get(prospectId);
    if (!prospect || prospect.tenantId !== tenantId) {
      throw new Error("Prospect not found");
    }

    const matches = await ctx.db
      .query("leadGenAuditMatches")
      .withIndex("by_tenantId_and_prospectId", (q) =>
        q.eq("tenantId", tenantId).eq("prospectId", prospect._id),
      )
      .order("desc")
      .take(25);

    return { prospect, matches };
  },
});

export const getAuditMatchForLead = query({
  args: {
    leadId: v.id("leads"),
  },
  handler: async (ctx, { leadId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const matches = await ctx.db
      .query("leadGenAuditMatches")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId),
      )
      .order("desc")
      .take(5);

    return matches.find((match) => match.matchStatus === "accepted") ?? null;
  },
});
