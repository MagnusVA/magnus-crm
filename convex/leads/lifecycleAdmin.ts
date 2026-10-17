import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { adminMoveLifecycleBack, adminSetDisposition, readLifecycle } from "../lib/leadLifecycle";
import { rejectRequest } from "../lib/observability/errors";
import { requireTenantUser } from "../requireTenantUser";
import { dispositionValidator, lifecycleStageValidator, stageIndex } from "./lifecycle";

// Admin corrections to a person's lifecycle (docs/plans/phase-1-foundations.md
// §4.3, §4.5, D4). The stage otherwise only moves forward on its own.

const REASON_MAX_LENGTH = 500;

function requireReason(reason: string, tenantId: Id<"tenants">): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > REASON_MAX_LENGTH) {
    throw rejectRequest(
      "lifecycle.reason_required",
      `Give a reason of 1 to ${REASON_MAX_LENGTH} characters.`,
      { tenantId },
    );
  }
  return trimmed;
}

async function requireActiveLead(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<Doc<"leads">> {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead || lead.tenantId !== tenantId) {
    throw rejectRequest("lifecycle.lead_not_found", "Lead not found.", { tenantId, leadId });
  }
  if (lead.status === "merged") {
    throw rejectRequest("lifecycle.lead_merged", "This lead was merged into another one.", { tenantId, leadId });
  }
  return lead;
}

export const moveLifecycleStageBack = mutation({
  args: {
    leadId: v.id("leads"),
    toStage: lifecycleStageValidator,
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const reason = requireReason(args.reason, tenantId);
    const lead = await requireActiveLead(ctx, tenantId, args.leadId);
    const current = readLifecycle(lead);
    if (!current || stageIndex(args.toStage) >= stageIndex(current.stage)) {
      throw rejectRequest(
        "lifecycle.not_lower_stage",
        "Pick a stage below the person's current one.",
        { tenantId, leadId: lead._id },
      );
    }
    if (current.stage === "customer" && lead.status === "converted") {
      // The customer record follows payments; voiding the payment moves both.
      throw rejectRequest(
        "lifecycle.customer_record",
        "This person has a customer record. Void the payment that made them a customer instead.",
        { tenantId, leadId: lead._id },
      );
    }
    await adminMoveLifecycleBack(ctx, lead, args.toStage, { actorUserId: userId, reason, at: Date.now() });
    return null;
  },
});

export const setDisposition = mutation({
  args: {
    leadId: v.id("leads"),
    disposition: dispositionValidator,
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const reason = requireReason(args.reason, tenantId);
    const lead = await requireActiveLead(ctx, tenantId, args.leadId);
    await adminSetDisposition(ctx, lead, args.disposition, { actorUserId: userId, reason, at: Date.now() });
    return null;
  },
});
