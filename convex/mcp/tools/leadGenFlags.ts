import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";

/**
 * `magnus_flag_capture`: a lead gen flags one of their own captures for an
 * admin to review (docs/plans/lead-gen-assistant.md, "Release 2").
 */
export const flagCaptureArgs = {
  submissionId: v.id("leadGenSubmissions"),
  reason: v.string(),
};

export const flagCapture = internalMutation({
  args: { caller: mcpCallerValidator, ...flagCaptureArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
