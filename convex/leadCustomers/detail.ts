import { v } from "convex/values";
import { query } from "../_generated/server";
import { listPersonEnrollments } from "../enrollments/read";
import { ENROLLMENT_DEAL_LIMIT } from "../lib/enrollments";
import { readResparkSettings } from "../lib/respark/settings";
import { DEFAULT_BUSINESS_DAY } from "../../lib/businessDay";
import { requireTenantUser } from "../requireTenantUser";
import { buildEntityDetailPayload } from "./detailPayload";
import { timelineEventLabel } from "./timeline";

export const getEntityDetail = query({
  args: { leadId: v.id("leads") },
  handler: async (ctx, { leadId }) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const lead = await ctx.db.get("leads", leadId);
    if (!lead || lead.tenantId !== tenantId) {
      return null;
    }

    if (lead.status === "merged" && lead.mergedIntoLeadId) {
      const targetLead = await ctx.db.get("leads", lead.mergedIntoLeadId);
      if (!targetLead || targetLead.tenantId !== tenantId) {
        return null;
      }
      return { kind: "redirect" as const, leadId: targetLead._id };
    }

    const [tenant, enrollments, opportunities, identifiers] = await Promise.all([
      ctx.db.get("tenants", tenantId),
      listPersonEnrollments(ctx, tenantId, leadId),
      ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", leadId),
        )
        .order("desc")
        // Every deal enrollments derive from, so the page's program totals
        // count all their payments; it lists the newest 50.
        .take(ENROLLMENT_DEAL_LIMIT),
      ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
        .order("desc")
        .take(100),
    ]);

    if (!tenant) throw new Error(`Missing tenant ${tenantId}`);

    const payload = await buildEntityDetailPayload(ctx, {
      tenantId,
      viewerUserId: userId,
      viewerRole: role,
      lead,
      enrollments,
      identifiers,
      opportunities,
    });
    // The Lifecycle card works out the inactive badge from these at render
    // (docs/plans/respark.md §6.3).
    return {
      ...payload,
      lastTouch: lead.lastTouch
        ? { ...lead.lastTouch, label: timelineEventLabel(lead.lastTouch.eventType) }
        : null,
      inactiveAfterDays: readResparkSettings(tenant).inactiveAfterDays,
      // Respark dates on the Lifecycle card show in the business day's zone,
      // so the server and the browser render the same day.
      businessTimeZone: (tenant.businessDay ?? DEFAULT_BUSINESS_DAY).timeZone,
    };
  },
});
