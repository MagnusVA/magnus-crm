import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { outcomesResultValidator, readMyOutcomesCore } from "../../leadGen/outcomes";
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
  returns: outcomesResultValidator,
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    return await readMyOutcomesCore(ctx, me, args);
  },
});
