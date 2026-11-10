import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";

/**
 * `magnus_respark_batch` and `magnus_respark_person`: the lead gen's held
 * respark batch and the panel for a few of its people (merged plan rows 4, 5).
 */
export const resparkBatchArgs = { cursor: v.optional(v.string()) };

export const batch = internalQuery({
  args: { caller: mcpCallerValidator, ...resparkBatchArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});

export const resparkPersonArgs = { itemIds: v.array(v.id("resparkBatchItems")) };

export const person = internalQuery({
  args: { caller: mcpCallerValidator, ...resparkPersonArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
