import { v } from "convex/values";
import { internalAction } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { mcpCallerValidator } from "../guard";
import { leadGenRangeArgs } from "../leadGenShared";
import { leadGenSourceValidator } from "../../leadGen/validators";

/**
 * `magnus_lead_gen_report`: the Operations lead gen report by section
 * (merged plan row 6). An action, because it follows the page's three data routes.
 */
export const reportArgs = {
  ...leadGenRangeArgs,
  sections: v.optional(
    v.array(
      v.union(
        v.literal("overview"),
        v.literal("specialists"),
        v.literal("teams"),
        v.literal("top_posts"),
        v.literal("conversions"),
        v.literal("respark"),
      ),
    ),
  ),
  source: v.optional(leadGenSourceValidator),
  cursor: v.optional(v.string()),
};

export const report = internalAction({
  args: { caller: mcpCallerValidator, ...reportArgs },
  returns: v.any(),
  handler: async () => {
    // The builder adds the guarded internal query (recordings.ts:84 pattern).
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
