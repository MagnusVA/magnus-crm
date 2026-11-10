import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import {
  flagCaptureCore,
  mcpCaptureFlag,
  mcpCaptureFlagValidator,
} from "../../leadGen/captureFlags";
import { withAgentErrors } from "../leadGenShared";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";

/**
 * `magnus_flag_capture`: a lead gen flags one of their own captures for an
 * admin to review. Repeats return the original flag, including after closure.
 */
export const flagCaptureArgs = {
  submissionId: v.id("leadGenSubmissions"),
  reason: v.string(),
};

export const flagCapture = internalMutation({
  args: { caller: mcpCallerValidator, ...flagCaptureArgs },
  returns: v.object({
    ok: v.literal(true),
    submissionId: v.id("leadGenSubmissions"),
    flag: mcpCaptureFlagValidator,
    alreadyFlagged: v.boolean(),
    stillCounts: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    const result = await withAgentErrors("flag.refused", () =>
      flagCaptureCore(ctx, me, args, {
        via: "mcp",
        agentClient: me.agentClient,
      }),
    );
    const submission = await ctx.db.get(
      "leadGenSubmissions",
      args.submissionId,
    );
    const stillCounts = submission?.voidedAt === undefined;
    return {
      ok: true as const,
      submissionId: args.submissionId,
      flag: mcpCaptureFlag(result.flag, me.timeZone),
      alreadyFlagged: result.alreadyFlagged,
      stillCounts,
      message: !stillCounts
        ? "This capture was already flagged and has been voided."
        : result.flag.state === "dismissed"
          ? "An admin dismissed this flag. This capture still counts."
          : "This capture is flagged for an admin to review. It still counts until an admin voids it.",
    };
  },
});
