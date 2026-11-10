import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { sha256Hex } from "../confirm";
import { FAMILY_LABELS, type WriteFamily } from "../families";
import { accessChangedAt, mcpCallerValidator, requireMcpAdmin } from "../guard";
import { committerFor } from "./committers";
import { applyPrepared, appLink, approvalPath, refusePrepared, type Echo } from "./prepare";

export const targetValidator = v.object({ kind: v.string(), id: v.string(), label: v.string() });

/**
 * `magnus_commit` (docs/plans/admin-assistant.md §4): applies one prepared
 * change. It takes the token and the readable echo the prepare step handed
 * back, and Magnus checks the echo against what it stored, so the client's
 * permission prompt shows the change in words. It is the only admin tool
 * marked destructive.
 */
export const commit = internalMutation({
  args: {
    caller: mcpCallerValidator,
    confirmToken: v.string(),
    action: v.string(),
    target: targetValidator,
    summary: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const me = await requireMcpAdmin(ctx, args.caller);
    const tokenHash = await sha256Hex(args.confirmToken);
    const row = await ctx.db
      .query("mcpConfirmations")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (!row || row.userId !== me.userId || row.tenantId !== me.tenantId || !row.kind) {
      throw rejectRequest("commit.token_unknown", "That token isn't valid. Prepare the change again.");
    }
    if (row.kind === "plan") {
      return {
        status: "needs_approval",
        approvalUrl: appLink(approvalPath(row._id)),
        message: "This change is approved by a person in Magnus, not committed in chat. Give the admin the link.",
      };
    }
    // The echo is compared before anything else, a replay included, so a
    // commit that doesn't say what was prepared never reads as done.
    const echo = JSON.parse(row.echoJson ?? "{}") as Echo;
    if (
      echo.action !== args.action ||
      echo.target?.id !== args.target.id ||
      echo.target?.kind !== args.target.kind ||
      echo.summary !== args.summary
    ) {
      throw rejectRequest(
        "commit.echo_mismatch",
        "This doesn't match the prepared change. Pass the prepare result's commit object unchanged.",
      );
    }
    if (row.usedAt !== undefined) {
      return { ...(JSON.parse(row.resultJson ?? "null") ?? {}), replay: true };
    }
    if (row.expiresAt < Date.now()) {
      throw rejectRequest("commit.expired", "That preview expired. Prepare the change again and read it back.");
    }
    const committer = committerFor(row.tool);
    if (!committer) throw rejectRequest("commit.unknown_change", "Magnus doesn't know that change any more. Prepare it again.");

    const family = row.family as WriteFamily;
    if (!me.writeFamilies.includes(family)) {
      return await refusePrepared(
        ctx,
        row,
        "mcp.family_off",
        `${FAMILY_LABELS[family]} changes are switched off for assistants in this workspace.`,
      );
    }
    if (accessChangedAt(me.user, me.tenant) > (row.createdAt ?? 0)) {
      return await refusePrepared(
        ctx,
        row,
        "mcp.access_changed",
        "Assistant access changed after this was prepared, so the preview no longer counts. Prepare it again.",
      );
    }
    return await applyPrepared(
      ctx,
      { userId: me.userId, tenantId: me.tenantId, role: me.role, agentClient: me.agentClient },
      row,
      committer,
    );
  },
});
