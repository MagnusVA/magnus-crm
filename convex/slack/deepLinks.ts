import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

type OpportunityOpenResolution =
  | {
      kind: "open";
      path: string;
    }
  | {
      kind: "no_access";
      reason: "not_found" | "forbidden";
      fallbackPath: string;
    };

function fallbackForRole(role: "tenant_master" | "tenant_admin" | "closer") {
  return role === "closer" ? "/workspace/closer" : "/workspace";
}

function opportunityPath(opportunityId: Id<"opportunities">) {
  return `/workspace/opportunities/${opportunityId}`;
}

function closerOpportunityPath(args: {
  opportunityId: Id<"opportunities">;
  latestMeetingId?: Id<"meetings">;
}) {
  if (args.latestMeetingId) {
    return `/workspace/closer/meetings/${args.latestMeetingId}`;
  }
  return opportunityPath(args.opportunityId);
}

export const resolveOpportunityOpen = query({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, args): Promise<OpportunityOpenResolution> => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const fallbackPath = fallbackForRole(role);
    const opportunity = await ctx.db.get(args.opportunityId);

    if (!opportunity || opportunity.tenantId !== tenantId) {
      return {
        kind: "no_access",
        reason: "not_found",
        fallbackPath,
      };
    }

    if (role === "tenant_master" || role === "tenant_admin") {
      return {
        kind: "open",
        path: opportunityPath(opportunity._id),
      };
    }

    if (opportunity.assignedCloserId === userId) {
      return {
        kind: "open",
        path: closerOpportunityPath({
          opportunityId: opportunity._id,
          latestMeetingId: opportunity.latestMeetingId,
        }),
      };
    }

    return {
      kind: "no_access",
      reason: "forbidden",
      fallbackPath,
    };
  },
});
