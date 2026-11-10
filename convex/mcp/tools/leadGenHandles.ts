import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ADMIN_ROLES, LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";

/**
 * `magnus_check_handles`: a read-only check of up to 10 handles (merged plan
 * row 2). Lead gens and admins share it; admins get capture detail.
 */
export const checkHandlesArgs = {
  handles: v.array(v.string()),
  cursor: v.optional(v.string()),
};

export const check = internalQuery({
  args: { caller: mcpCallerValidator, ...checkHandlesArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, [...LEAD_GEN_ROLES, ...LEAD_GEN_ADMIN_ROLES]);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
