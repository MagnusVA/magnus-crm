import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";

/**
 * `magnus_lead_gen_today`: the lead gen's shift in counts (merged plan row 1).
 */
export const todayArgs = {};

export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...todayArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
