import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ADMIN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";

/**
 * `magnus_lead_gen_floor` and `magnus_lead_gen_roster`: today per specialist,
 * and the roster with teams and respark rules (merged plan rows 7, 8).
 */
export const floorArgs = {
  teamId: v.optional(v.id("attributionTeams")),
  cursor: v.optional(v.string()),
};

export const floor = internalQuery({
  args: { caller: mcpCallerValidator, ...floorArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ADMIN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});

export const rosterArgs = {
  includeInactive: v.optional(v.boolean()),
  cursor: v.optional(v.string()),
};

export const roster = internalQuery({
  args: { caller: mcpCallerValidator, ...rosterArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ADMIN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
