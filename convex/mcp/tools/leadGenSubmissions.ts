import { v } from "convex/values";
import { internalAction } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { mcpCallerValidator } from "../guard";
import { leadGenRangeArgs } from "../leadGenShared";
import { leadGenSourceValidator } from "../../leadGen/validators";

/**
 * `magnus_lead_gen_submissions`: raw captures a page at a time (merged plan
 * row 9). An action that accumulates the page query.
 */
export const submissionsArgs = {
  ...leadGenRangeArgs,
  workerId: v.optional(v.id("leadGenWorkers")),
  teamId: v.optional(v.id("attributionTeams")),
  source: v.optional(leadGenSourceValidator),
  cursor: v.optional(v.string()),
};

export const list = internalAction({
  args: { caller: mcpCallerValidator, ...submissionsArgs },
  returns: v.any(),
  handler: async () => {
    // The builder adds the guarded internal query (recordings.ts:84 pattern).
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
