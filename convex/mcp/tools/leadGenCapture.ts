import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";
import { leadGenOriginKindValidator, leadGenSourceValidator } from "../../leadGen/validators";

/**
 * `magnus_capture_prospects`: save a short list of handles from one origin,
 * previewed first (merged plan row 10).
 */
export const captureArgs = {
  requestKey: v.string(),
  source: leadGenSourceValidator,
  origin: v.object({ kind: leadGenOriginKindValidator, value: v.optional(v.string()) }),
  handles: v.array(v.string()),
  includeDoNotContact: v.optional(v.boolean()),
  confirm: v.boolean(), confirmToken: v.optional(v.string()),
};

export const capture = internalMutation({
  args: { caller: mcpCallerValidator, ...captureArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
