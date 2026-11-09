import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { MEMBER_REPORT_ROLES, viewerTeamMemberId } from "./lib/access";

/**
 * The viewer's own team member, for "My report"
 * (`/workspace/reports/people/me`). Null when the account isn't linked to a
 * team member yet. The member report's queries check the member again.
 */
export const getMyTeamMemberId = query({
  args: {},
  returns: v.union(v.id("teamMembers"), v.null()),
  handler: async (ctx) => {
    const viewer = await requireTenantUser(ctx, [...MEMBER_REPORT_ROLES]);
    return await viewerTeamMemberId(ctx, viewer);
  },
});
