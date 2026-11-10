import { v } from "convex/values";
import { internalAction } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { mcpCallerValidator } from "../guard";
import { leadGenRangeArgs } from "../leadGenShared";

/**
 * `magnus_my_lead_gen_activity`: the lead gen's own numbers for a range
 * (merged plan row 3). An action, because past ranges read the warehouse.
 */
export const myActivityArgs = {
  ...leadGenRangeArgs,
  cursor: v.optional(v.string()),
};

export const myActivity = internalAction({
  args: { caller: mcpCallerValidator, ...myActivityArgs },
  returns: v.any(),
  handler: async () => {
    // The builder adds the guarded internal query (recordings.ts:84 pattern).
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
