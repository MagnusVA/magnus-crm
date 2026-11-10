import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";

/**
 * `magnus_claim_respark_batch` and `magnus_mark_respark_items`: claim today's
 * batch, and record what happened with its people (merged plan rows 11, 12).
 */
export const claimArgs = {};

export const claim = internalMutation({
  args: { caller: mcpCallerValidator, ...claimArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});

export const markArgs = {
  marks: v.array(
    v.object({
      itemId: v.id("resparkBatchItems"),
      result: v.union(v.literal("resparked"), v.literal("not_a_fit"), v.literal("skipped")),
    }),
  ),
  confirm: v.boolean(), confirmToken: v.optional(v.string()),
};

export const mark = internalMutation({
  args: { caller: mcpCallerValidator, ...markArgs },
  returns: v.any(),
  handler: async (ctx, { caller }) => {
    await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    throw rejectRequest("mcp.not_built", "This tool isn't built yet.");
  },
});
