import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { normalizeCorrectionReason, voidSubmissionCore } from "../../leadGen/corrections";
import { rejectRequest } from "../../lib/observability/errors";
import { issueConfirmation, markConfirmationUsed, redeemConfirmation } from "../confirm";
import { LEAD_GEN_ADMIN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";
import { withAgentErrors } from "../leadGenShared";
import { formatLocal } from "../time";

/**
 * `magnus_void_capture`: an admin removes a wrong capture's report credit
 * (docs/plans/lead-gen-assistant.md §2 row 13), on the core the Operations
 * page uses. A void has no undo, so it previews first and commits with a
 * token. A capture that is already voided gets no token.
 */
const TOOL = "magnus_void_capture";

export const voidArgs = {
  submissionId: v.id("leadGenSubmissions"),
  reason: v.string(),
  confirm: v.boolean(),
  confirmToken: v.optional(v.string()),
};

export const voidCapture = internalMutation({
  args: { caller: mcpCallerValidator, ...voidArgs },
  returns: v.union(
    v.object({
      preview: v.string(),
      alreadyVoided: v.boolean(),
      // Absent when the capture is already voided.
      confirmToken: v.optional(v.string()),
      expiresInSeconds: v.optional(v.number()),
    }),
    v.object({
      ok: v.literal(true),
      submissionId: v.id("leadGenSubmissions"),
      alreadyVoided: v.boolean(),
      message: v.string(),
    }),
  ),
  handler: async (ctx, { caller, submissionId, reason: rawReason, confirm, confirmToken }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ADMIN_ROLES);
    const reason = await withAgentErrors("void.refused", () => normalizeCorrectionReason(rawReason));
    const hashed = { submissionId, reason };

    const redeemed = confirm ? await redeemConfirmation(ctx, me, TOOL, confirmToken, hashed) : null;
    if (redeemed?.kind === "replay") return redeemed.result as never;

    const submission = await ctx.db.get("leadGenSubmissions", submissionId);
    if (!submission || submission.tenantId !== me.tenantId) {
      throw rejectRequest("void.not_found", "That capture isn't in this workspace.");
    }
    const [prospect, worker] = await Promise.all([
      ctx.db.get("leadGenProspects", submission.prospectId),
      ctx.db.get("leadGenWorkers", submission.workerId),
    ]);
    const handle = prospect ? `@${prospect.normalizedHandle}` : "this person";
    const specialist = worker?.displayName ?? worker?.email ?? "a specialist";
    const when = formatLocal(submission.submittedAt, me.timeZone);

    if (!redeemed) {
      if (submission.voidedAt !== undefined) {
        await withAgentErrors("void.refused", () => voidSubmissionCore(ctx, me, { submissionId, reason }, { via: "mcp", agentClient: me.agentClient }));
        return {
          preview: `${specialist}'s capture of ${handle} on ${when} was already voided on ${formatLocal(submission.voidedAt, me.timeZone)}. Nothing to do.`,
          alreadyVoided: true,
        };
      }
      const preview = [
        `Void ${specialist}'s capture of ${handle} on ${when}.`,
        `It comes off ${specialist}'s numbers and the reports for that day, and off its post's totals.`,
        "It does not rewind lifetime counters or past deal credit.",
        "A void can't be undone.",
        `Reason: ${reason}`,
      ].join("\n");
      const issued = await issueConfirmation(ctx, me, TOOL, hashed, preview);
      return { ...issued, alreadyVoided: false };
    }

    const voided = await withAgentErrors("void.refused", () =>
      voidSubmissionCore(ctx, me, { submissionId, reason }, { via: "mcp", agentClient: me.agentClient }),
    );
    const result = {
      ok: true as const,
      submissionId: voided.submissionId,
      alreadyVoided: voided.alreadyVoided,
      message: voided.alreadyVoided
        ? `${specialist}'s capture of ${handle} was already voided. Nothing changed.`
        : `Voided ${specialist}'s capture of ${handle} on ${when}.`,
    };
    await markConfirmationUsed(ctx, redeemed.confirmationId, result);
    return result;
  },
});
