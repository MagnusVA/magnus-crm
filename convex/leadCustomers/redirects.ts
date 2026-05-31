import { v } from "convex/values";
import { query } from "../_generated/server";
import type { CrmRole } from "../lib/roleMapping";
import { requireTenantUser } from "../requireTenantUser";

const LEGACY_ROUTE_ROLES: CrmRole[] = [
	"tenant_master",
	"tenant_admin",
	"closer",
];

export const resolveLeadRedirect = query({
	args: { leadId: v.id("leads") },
	handler: async (ctx, { leadId }) => {
		const { tenantId } = await requireTenantUser(ctx, LEGACY_ROUTE_ROLES);
		const lead = await ctx.db.get(leadId);
		if (!lead || lead.tenantId !== tenantId) return null;

		if (lead.status === "merged" && lead.mergedIntoLeadId) {
			const target = await ctx.db.get(lead.mergedIntoLeadId);
			if (target?.tenantId === tenantId) return { leadId: target._id };
			return null;
		}

		return { leadId: lead._id };
	},
});

export const resolveCustomerRedirect = query({
	args: { customerId: v.id("customers") },
	handler: async (ctx, { customerId }) => {
		const { tenantId } = await requireTenantUser(ctx, LEGACY_ROUTE_ROLES);
		const customer = await ctx.db.get(customerId);
		if (!customer || customer.tenantId !== tenantId) return null;

		const lead = await ctx.db.get(customer.leadId);
		if (!lead || lead.tenantId !== tenantId) return null;

		if (lead.status === "merged" && lead.mergedIntoLeadId) {
			const target = await ctx.db.get(lead.mergedIntoLeadId);
			if (target?.tenantId === tenantId) {
				return { leadId: target._id, customerId: customer._id };
			}
			return null;
		}

		return { leadId: lead._id, customerId: customer._id };
	},
});

export const resolveOpportunityRedirect = query({
	args: { opportunityId: v.id("opportunities") },
	handler: async (ctx, { opportunityId }) => {
		const { tenantId, userId, role } = await requireTenantUser(
			ctx,
			LEGACY_ROUTE_ROLES,
		);
		const opportunity = await ctx.db.get(opportunityId);
		if (!opportunity || opportunity.tenantId !== tenantId) return null;

		const isAdmin = role === "tenant_master" || role === "tenant_admin";
		if (!isAdmin && opportunity.assignedCloserId !== userId) return null;

		const lead = await ctx.db.get(opportunity.leadId);
		if (!lead || lead.tenantId !== tenantId) return null;

		if (lead.status === "merged" && lead.mergedIntoLeadId) {
			const target = await ctx.db.get(lead.mergedIntoLeadId);
			if (target?.tenantId === tenantId) {
				return {
					leadId: target._id,
					opportunityId: opportunity._id,
				};
			}
			return null;
		}

		return {
			leadId: lead._id,
			opportunityId: opportunity._id,
		};
	},
});
