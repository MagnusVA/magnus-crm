import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { log } from "../lib/observability/log";
import { requireTenantUser } from "../requireTenantUser";
import { applyLeadGenAggregateDelta } from "./aggregates";

const MIN_CORRECTION_REASON_LENGTH = 3;
const MAX_CORRECTION_REASON_LENGTH = 1000;

function normalizeCorrectionReason(reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_CORRECTION_REASON_LENGTH) {
    throw new Error("A correction reason is required");
  }
  if (trimmed.length > MAX_CORRECTION_REASON_LENGTH) {
    throw new Error(
      `Correction reason must be ${MAX_CORRECTION_REASON_LENGTH} characters or fewer`,
    );
  }
  return trimmed;
}

export const voidSubmission = mutation({
  args: {
    submissionId: v.id("leadGenSubmissions"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const reason = normalizeCorrectionReason(args.reason);
    const submission = await ctx.db.get("leadGenSubmissions", args.submissionId);

    if (!submission || submission.tenantId !== tenantId) {
      throw new Error("Submission not found");
    }

    if (submission.voidedAt) {
      log.info("lead_gen.submission.void_skipped", {
        reason: "already_voided",
        tenantId,
        submissionId: submission._id,
        userId,
      });
      return { submissionId: submission._id, alreadyVoided: true };
    }

    const now = Date.now();
    const afterSnapshot = {
      ...submission,
      voidedAt: now,
      voidedByUserId: userId,
      voidReason: reason,
    };

    await applyLeadGenAggregateDelta(ctx, {
      submission,
      delta: -1,
      reason: "voided",
    });

    await ctx.db.patch("leadGenSubmissions", submission._id, {
      voidedAt: now,
      voidedByUserId: userId,
      voidReason: reason,
    });

    await ctx.db.insert("leadGenCorrectionEvents", {
      tenantId,
      targetType: "submission",
      targetId: submission._id,
      correctionKind: "voided",
      reason,
      beforeSnapshot: JSON.stringify(submission),
      afterSnapshot: JSON.stringify(afterSnapshot),
      correctedByUserId: userId,
      correctedAt: now,
    });

    log.info("lead_gen.submission.voided", {
      tenantId,
      submissionId: submission._id,
      prospectId: submission.prospectId,
      userId,
    });

    return { submissionId: submission._id, alreadyVoided: false };
  },
});
