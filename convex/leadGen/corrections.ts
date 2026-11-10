import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import type { Provenance } from "../mcp/guard";
import { log } from "../lib/observability/log";
import { requireTenantUser } from "../requireTenantUser";
import { applyLeadGenAggregateDelta } from "./aggregates";
import { emitCaptureVoidedEvent } from "./prospectPeople";
import { closeCaptureFlagAsVoided } from "./captureFlags";
import { refreshResparkTeam } from "../lib/respark/state";

const MIN_CORRECTION_REASON_LENGTH = 3;
const MAX_CORRECTION_REASON_LENGTH = 1000;

export function normalizeCorrectionReason(reason: string) {
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
    const access = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    return await voidSubmissionCore(ctx, access, args);
  },
});

/**
 * Voids one capture, for the web and for the agent
 * (docs/plans/lead-gen-assistant.md §2, row 13). The caller checks the role.
 */
export async function voidSubmissionCore(
  ctx: MutationCtx,
  { tenantId, userId }: { tenantId: Id<"tenants">; userId: Id<"users"> },
  args: { submissionId: Id<"leadGenSubmissions">; reason: string },
  provenance: Provenance = { via: "web" },
): Promise<{ submissionId: Id<"leadGenSubmissions">; alreadyVoided: boolean }> {
  const reason = normalizeCorrectionReason(args.reason);
  const submission = await ctx.db.get("leadGenSubmissions", args.submissionId);

  if (!submission || submission.tenantId !== tenantId) {
    throw new Error("Submission not found");
  }

  await closeCaptureFlagAsVoided(ctx, { tenantId, userId }, submission._id);

  if (submission.voidedAt !== undefined) {
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

  // The void is a touch on the person's timeline. A prospect the link
  // backfill hasn't reached gets it from the capture backfill.
  const prospect = await ctx.db.get("leadGenProspects", submission.prospectId);
  if (prospect?.leadId) {
    await emitCaptureVoidedEvent(ctx, afterSnapshot, prospect.leadId, { provenance });
    // The voided capture may have decided their Respark team.
    await refreshResparkTeam(ctx, tenantId, prospect.leadId);
  }

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
    via: provenance.via,
  });

  return { submissionId: submission._id, alreadyVoided: false };
}
