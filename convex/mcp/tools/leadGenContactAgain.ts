import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";

/**
 * `magnus_set_contact_again`: save or clear the date a person asked to be
 * contacted again (docs/plans/lead-gen-assistant.md, "Release 2").
 */
export const contactAgainArgs = {
  submissionId: v.optional(v.id("leadGenSubmissions")),
  itemId: v.optional(v.id("resparkBatchItems")),
  date: v.union(v.string(), v.null()),
  note: v.optional(v.string()),
};

export const setContactAgain = internalMutation({
  args: { caller: mcpCallerValidator, ...contactAgainArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
