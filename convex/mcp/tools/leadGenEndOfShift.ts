import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";

/**
 * `magnus_end_lead_gen_shift`: save the day's report and post it to the lead
 * gen Slack channel (docs/plans/lead-gen-assistant.md, "Release 2").
 */
export const endShiftArgs = {
  narrative: v.optional(v.string()),
  note: v.optional(v.string()),
  confirm: v.boolean(),
  confirmToken: v.optional(v.string()),
};

export const endShift = internalMutation({
  args: { caller: mcpCallerValidator, ...endShiftArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
