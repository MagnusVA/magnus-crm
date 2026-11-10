import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";
import { leadGenRangeArgs } from "../leadGenShared";

/**
 * `magnus_my_lead_gen_outcomes`: what happened to the people a lead gen
 * captured (docs/plans/lead-gen-assistant.md, "Release 2").
 */
export const outcomesArgs = {
  ...leadGenRangeArgs,
  stage: v.optional(
    v.union(
      v.literal("prospect"),
      v.literal("in_conversation"),
      v.literal("qualified"),
      v.literal("booked"),
      v.literal("showed"),
      v.literal("customer"),
    ),
  ),
  cursor: v.optional(v.string()),
};

export const outcomes = internalQuery({
  args: { caller: mcpCallerValidator, ...outcomesArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
