import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ADMIN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";

/**
 * `magnus_void_capture`: an admin removes a wrong capture's credit, previewed
 * first (merged plan row 13).
 */
export const voidArgs = {
  submissionId: v.id("leadGenSubmissions"),
  reason: v.string(),
  confirm: v.boolean(), confirmToken: v.optional(v.string()),
};

export const voidCapture = internalMutation({
  args: { caller: mcpCallerValidator, ...voidArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ADMIN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
