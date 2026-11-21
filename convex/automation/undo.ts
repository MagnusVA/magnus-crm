import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import { expectedError, rejectRequest } from "../lib/observability/errors";
import type { CoreActor } from "../lib/outcomeCores";
import { hasPermission, PERMISSIONS } from "../lib/permissions";
import {
  automationCommandRefusalValidator, refuseAutomation, type AutomationCommandResult, type PaymentCommandCode,
} from "../payments/commandResult";
import { requireBillingOpsEnabled } from "../billing/guards";
import { excludePaymentCore, previewExclusionCore } from "../payments/exclude";
import { requireTenantUser } from "../requireTenantUser";
import { automationKindOf, isPaymentKind } from "./proposals";
import { reopenRefusalCore } from "./refusal";
import { automationKindValidator } from "./schema";
import { undoCallTaskCore } from "./taskCorrections";

// One-tap Undo of an automatic write (phase 3 contract §2.15). Allowed only
// for an applied automatic decision with stored before-fields, while nothing
// a person did has touched the deal since the write (its humanResultRevision
// is the one the write left). Anything else is the reviewed correction.
// Each kind goes through the core that already reverses it:
//   payments  -> the exclusion core at level "undo", cause "wrong_match";
//   tasks     -> undoCallTaskCore, with the "did the call happen?" answer;
//   refusals  -> reopenRefusalCore.

type Decision = Doc<"resultAutomationDecisions">;

const LIST_LIMIT = 100;
const MAX_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;
const UNDO_ROLES = ["closer", "tenant_master", "tenant_admin"] as const;

const automaticWriteValidator = v.object({
  decisionId: v.id("resultAutomationDecisions"),
  kind: automationKindValidator,
  writtenAt: v.number(),
  before: v.optional(v.object({
    position: v.union(v.literal("booked"), v.literal("follow_up"), v.literal("system_loss"), v.literal("won")),
  })),
  leadId: v.optional(v.id("leads")),
  opportunityId: v.optional(v.id("opportunities")),
  meetingId: v.optional(v.id("meetings")),
  providerPaymentId: v.optional(v.id("providerPayments")),
  paymentRecordId: v.optional(v.id("paymentRecords")),
  followUpId: v.optional(v.id("followUps")),
  auditReason: v.optional(v.union(v.literal("canary"), v.literal("sampled"))),
  auditOpenDueAt: v.optional(v.number()),
  /** No person has touched the deal since the write, so one-tap Undo may apply. */
  untouched: v.boolean(),
});

/** Everything automation recorded by itself in the window, newest first. */
export const listAutomaticWrites = query({
  args: { kind: v.optional(automationKindValidator), days: v.number() },
  returns: v.object({ writes: v.array(automaticWriteValidator), capped: v.boolean() }),
  handler: async (ctx, { kind, days }) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:view"]]);
    if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
      throw expectedError("automation.invalid_window", `Choose a window from 1 to ${MAX_WINDOW_DAYS} days.`);
    }
    const since = Date.now() - days * DAY_MS;
    const rows = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_mode_and_state_and_resolvedAt", (q) =>
        q.eq("tenantId", tenantId).eq("mode", "automatic").eq("state", "applied").gte("resolvedAt", since))
      .order("desc")
      .take(LIST_LIMIT + 1);
    const writes: Array<typeof automaticWriteValidator.type> = [];
    for (const row of rows.slice(0, LIST_LIMIT)) {
      const rowKind = automationKindOf(row.kind);
      if (!rowKind || (kind && rowKind !== kind) || row.appliedVia !== "automatic") continue;
      const deal = row.opportunityId ? await ctx.db.get("opportunities", row.opportunityId) : null;
      const before = row.before ?? row.callBefore;
      writes.push({
        decisionId: row._id, kind: rowKind, writtenAt: row.resolvedAt ?? row.createdAt,
        before: before ? { position: before.position } : undefined,
        leadId: row.leadId, opportunityId: row.opportunityId, meetingId: row.meetingId,
        providerPaymentId: row.providerPaymentId, paymentRecordId: row.appliedPaymentRecordId,
        followUpId: row.writtenFollowUpId, auditReason: row.auditReason, auditOpenDueAt: row.auditOpenDueAt,
        untouched: deal?.tenantId === tenantId && row.humanResultRevisionAfter !== undefined &&
          (deal.humanResultRevision ?? 0) === row.humanResultRevisionAfter,
      });
    }
    return { writes, capped: rows.length > LIST_LIMIT };
  },
});

function isAutomaticReceipt(decision: Decision): boolean {
  return decision.mode === "automatic" && decision.appliedVia === "automatic" && decision.resolvedByUserId === undefined;
}

function fromPaymentCode(code: PaymentCommandCode): "stale_preview" | "needs_review" {
  return code === "stale_preview" ? "stale_preview" : "needs_review";
}

async function undoAutomaticPayment(
  ctx: MutationCtx, actor: CoreActor, decision: Decision,
): Promise<AutomationCommandResult> {
  if (!hasPermission(actor.role, "billing:correct")) {
    throw rejectRequest("auth.insufficient_permissions", "Insufficient permissions", {
      userId: actor.userId, role: actor.role,
    });
  }
  await requireBillingOpsEnabled(ctx, actor.tenantId);
  if (decision.state === "undone" && decision.appliedVia === "automatic") return { ok: true, alreadyApplied: true };
  if (decision.state !== "applied" || !isAutomaticReceipt(decision) || !decision.before ||
      !decision.appliedPaymentRecordId || !decision.opportunityId) {
    return refuseAutomation("not_ready");
  }
  const deal = await ctx.db.get("opportunities", decision.opportunityId);
  if (!deal || deal.tenantId !== actor.tenantId) return refuseAutomation("not_ready");
  if (decision.humanResultRevisionAfter === undefined ||
      (deal.humanResultRevision ?? 0) !== decision.humanResultRevisionAfter) return refuseAutomation("needs_review");

  const exclusion = { paymentRecordId: decision.appliedPaymentRecordId, cause: "wrong_match" as const };
  // The preview pins the facts; the core re-reads them in this same mutation.
  const preview = await previewExclusionCore(ctx, actor, exclusion);
  if (preview.refusal) return refuseAutomation(preview.refusal === "deal_not_won" ? "needs_review" : fromPaymentCode(preview.refusal));
  // A later payment can be removed only while another payment keeps the deal won.
  const keepsWin = decision.kind === "additional_payment" && preview.survivors.length > 0;
  if (!preview.undo.allowed && !keepsWin) return refuseAutomation("needs_review");
  const result = await excludePaymentCore(ctx, actor, {
    ...exclusion, level: "undo", expectedFingerprint: preview.fingerprint,
  }, "billing");
  if (!result.ok) return refuseAutomation(fromPaymentCode(result.code));
  // The exclusion core records a kept win as a correction. This route has
  // also checked the untouched automatic receipt, so it can mark it undone.
  if (!result.alreadyApplied) {
    await ctx.db.patch("resultAutomationDecisions", decision._id, {
      state: "undone",
      auditOpenDueAt: decision.auditOpenDueAt,
    });
  }
  return { ok: true, alreadyApplied: result.alreadyApplied };
}

async function undoAutomaticTask(
  ctx: MutationCtx, actor: CoreActor, decision: Decision, callHappened: boolean | undefined,
): Promise<AutomationCommandResult> {
  if (callHappened === undefined) {
    throw expectedError("automation.call_happened_required", "Say whether the call happened.");
  }
  if (decision.state === "undone" && decision.appliedVia === "automatic") return { ok: true, alreadyApplied: true };
  if (decision.state !== "applied" || !isAutomaticReceipt(decision)) return refuseAutomation("not_ready");
  // The core checks who may undo (owner or admin; the assigned closer when the
  // call happened), that the task is untouched, and the cross-kind cases.
  const result = await undoCallTaskCore(ctx, actor, decision._id, { callHappened });
  return result.ok ? { ok: true, alreadyApplied: result.alreadyApplied } : refuseAutomation(result.code);
}

async function undoAutomaticRefusal(
  ctx: MutationCtx, actor: CoreActor, decision: Decision,
): Promise<AutomationCommandResult> {
  if (decision.state === "applied" && !isAutomaticReceipt(decision)) return refuseAutomation("not_ready");
  return await reopenRefusalCore(ctx, actor, decision._id);
}

export async function undoAutomaticWriteCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: { decisionId: Id<"resultAutomationDecisions">; callHappened?: boolean },
): Promise<AutomationCommandResult> {
  const decision = await ctx.db.get("resultAutomationDecisions", args.decisionId);
  if (!decision || decision.tenantId !== actor.tenantId) return refuseAutomation("not_ready");
  const kind = decision.kind;
  if (isPaymentKind(kind)) return await undoAutomaticPayment(ctx, actor, decision);
  if (kind === "call_back" || kind === "payment_owed") {
    return await undoAutomaticTask(ctx, actor, decision, args.callHappened);
  }
  if (kind === "refusal_loss") return await undoAutomaticRefusal(ctx, actor, decision);
  return refuseAutomation("not_ready");
}

/**
 * Payments: `billing:correct` (owner or admin). Tasks: owner or admin, or
 * the assigned closer for their own task when the call happened. Refusals:
 * the assigned closer while untouched, or an owner or admin.
 */
export const undoAutomaticWrite = mutation({
  args: { decisionId: v.id("resultAutomationDecisions"), callHappened: v.optional(v.boolean()) },
  returns: v.union(automationCommandRefusalValidator, v.object({ ok: v.literal(true), alreadyApplied: v.boolean() })),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...UNDO_ROLES]);
    return await undoAutomaticWriteCore(ctx, actor, args);
  },
});
