import { v } from "convex/values";
import { businessDateForInstant, businessDayRange } from "../../lib/businessDay";
import type { Doc } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { modeAtLeastAsk, paymentEvidenceOf, paymentProposalOf } from "../automation/proposals";
import { effectiveKindMode } from "../automation/settings";
import { requireBillingOpsEnabled, requireBillingPermission } from "../billing/guards";
import { recordAttendanceOnlyCore } from "../closer/attendanceOnly";
import { noShowReasonValidator } from "../closer/noShowActions";
import { expectedError } from "../lib/observability/errors";
import { paymentTypeValidator } from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import { applyProviderPayment, previewProviderApply, providerApplyPreviewValidator, providerApplyResultValidator } from "./apply";
import { refuse } from "./commandResult";

type ReadCtx = QueryCtx | MutationCtx;
type Decision = Doc<"resultAutomationDecisions">;
const ROLES = ["closer", "tenant_master", "tenant_admin"] as const;
const previewArgs = { providerPaymentId: v.id("providerPayments"), opportunityId: v.id("opportunities") };
const approvalArgs = {
  providerPaymentId: previewArgs.providerPaymentId,
  decisionId: v.optional(v.id("resultAutomationDecisions")),
  expectedFingerprint: v.string(),
  expectedAllocationRevision: v.number(),
};

export async function findReadyWhopDecision(ctx: ReadCtx, payment: Doc<"providerPayments">) {
  if (payment.paymentRecordId) return null;
  return await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_providerPaymentId_and_state", (q) =>
      q.eq("tenantId", payment.tenantId).eq("providerPaymentId", payment._id).eq("state", "ready"))
    .unique();
}

export function isCurrentWhopAsk(
  tenant: Doc<"tenants">,
  decision: Decision,
  deal: Doc<"opportunities">,
  payment: Doc<"providerPayments">,
): boolean {
  const { kind } = decision;
  const settings = tenant.resultAutomation;
  return tenant.status === "active" && (kind === "payment_win" || kind === "additional_payment") &&
    decision.tenantId === tenant._id && deal.tenantId === tenant._id && payment.tenantId === tenant._id &&
    decision.state === "ready" && modeAtLeastAsk(decision.mode) && modeAtLeastAsk(effectiveKindMode(tenant, kind)) &&
    decision.opportunityId === deal._id && decision.leadId === deal.leadId &&
    decision.providerPaymentId === payment._id && payment.status === "paid" && !payment.paymentRecordId &&
    payment.adverseState === "none" && payment.adverseFencedAt === undefined && payment.refundedMinor === 0 &&
    (kind === "additional_payment" ? deal.outcome === "won" : deal.outcome === "open" || deal.outcome === "lost") &&
    decision.assignedCloserId === deal.assignedCloserId &&
    (decision.noticeUserId === undefined || decision.noticeUserId === deal.assignedCloserId) &&
    decision.activationVersion === settings?.activationVersion &&
    decision.policyVersion === settings?.kinds[kind].policyVersion &&
    decision.humanResultRevision === (deal.humanResultRevision ?? 0) &&
    paymentEvidenceOf(decision)?.allocationRevision === payment.allocationRevision &&
    paymentEvidenceOf(decision)?.sourceUpdatedAt === payment.sourceUpdatedAt;
}

function billingAvailableAt(tenant: Doc<"tenants">, decision: Decision | null) {
  if (decision?.noticeUserId === undefined) return undefined;
  const date = businessDateForInstant(decision.createdAt, tenant.businessDay);
  const { start, end } = businessDayRange(date, tenant.businessDay);
  return decision.createdAt + (end - start);
}

const waitingValidator = v.object({
  waitsOn: v.union(v.literal("closer"), v.literal("billing")),
  waitingSince: v.number(),
  ageMs: v.number(),
  closerId: v.optional(v.id("users")),
  billingAvailableAt: v.optional(v.number()),
});

export function describeWhopWait(
  tenant: Doc<"tenants">,
  payment: Doc<"providerPayments">,
  decision: Decision | null,
  now: number,
): typeof waitingValidator.type {
  const availableAt = billingAvailableAt(tenant, decision);
  const waitingSince = payment.notMySaleAt ?? decision?.createdAt ?? payment.firstSeenAt;
  const closerId = availableAt !== undefined && now < availableAt ? decision?.noticeUserId : undefined;
  return {
    waitsOn: closerId ? "closer" : "billing",
    waitingSince,
    ageMs: Math.max(0, now - waitingSince),
    closerId,
    billingAvailableAt: availableAt,
  };
}

const askTarget = v.union(
  v.object({ kind: v.literal("meeting"), meetingId: v.id("meetings") }),
  v.object({ kind: v.literal("reminder"), followUpId: v.id("followUps") }),
);

export const getWhopAsk = query({
  args: { target: askTarget },
  returns: v.union(v.null(), v.object({
    decisionId: v.id("resultAutomationDecisions"),
    providerPaymentId: v.id("providerPayments"),
    opportunityId: v.id("opportunities"),
    createdAt: v.number(),
    preview: providerApplyPreviewValidator,
  })),
  handler: async (ctx, { target }) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [...ROLES]);
    const item = target.kind === "meeting" ? await ctx.db.get("meetings", target.meetingId)
      : await ctx.db.get("followUps", target.followUpId);
    if (item?.tenantId !== tenantId ||
        ("closerId" in item && (item.type !== "manual_reminder" ||
          item.reason === "stale_opportunity_nudge" || (role === "closer" && item.closerId !== userId)))) return null;
    const [deal, tenant] = await Promise.all([
      ctx.db.get("opportunities", item.opportunityId), ctx.db.get("tenants", tenantId),
    ]);
    if (!tenant || deal?.tenantId !== tenantId || (role === "closer" && deal.assignedCloserId !== userId)) return null;
    const decisions = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_opportunityId_and_state", (q) =>
        q.eq("tenantId", tenantId).eq("opportunityId", deal._id).eq("state", "ready"))
      .order("desc").take(20);
    const now = Date.now();
    for (const decision of decisions) {
      if (!decision.providerPaymentId || decision.confirmRoute !== target.kind ||
          (target.kind === "meeting" && (decision.meetingId !== target.meetingId || item.status !== "scheduled")) ||
          (target.kind === "reminder" && (paymentProposalOf(decision)?.completesFollowUpId !== target.followUpId || item.status !== "pending"))) continue;
      const payment = await ctx.db.get("providerPayments", decision.providerPaymentId);
      if (!payment || !isCurrentWhopAsk(tenant, decision, deal, payment)) continue;
      const preview = await previewProviderApply(ctx, {
        tenantId, opportunityId: deal._id, providerPaymentId: payment._id, now,
      });
      const proposal = paymentProposalOf(decision);
      if (!preview.ok || proposal?.programId !== preview.proposal.programId ||
          proposal?.paymentType !== preview.proposal.paymentType ||
          proposal?.amountMinor !== preview.proposal.amountMinor ||
          proposal?.currency !== preview.proposal.currency) return null;
      return { decisionId: decision._id, providerPaymentId: payment._id, opportunityId: deal._id, createdAt: decision.createdAt, preview };
    }
    return null;
  },
});

export const previewWhopConfirm = query({
  args: previewArgs,
  returns: v.object({
    preview: providerApplyPreviewValidator,
    waiting: v.union(waitingValidator, v.null()),
    decisionId: v.optional(v.id("resultAutomationDecisions")),
    attendanceOwedMeetingIds: v.array(v.id("meetings")),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:review");
    await requireBillingOpsEnabled(ctx, tenantId);
    const now = Date.now();
    const preview = await previewProviderApply(ctx, { ...args, tenantId, now });
    const [payment, tenant] = await Promise.all([
      ctx.db.get("providerPayments", args.providerPaymentId), ctx.db.get("tenants", tenantId),
    ]);
    if (payment?.tenantId !== tenantId || !tenant) return { preview, waiting: null, attendanceOwedMeetingIds: [] };
    const [decision, meetings] = await Promise.all([
      findReadyWhopDecision(ctx, payment),
      preview.ok && preview.kind === "payment_win"
        ? ctx.db.query("meetings").withIndex("by_opportunityId_and_status_and_scheduledAt", (q) =>
          q.eq("opportunityId", args.opportunityId).eq("status", "scheduled")).take(20)
        : [],
    ]);
    return {
      preview,
      waiting: describeWhopWait(tenant, payment, decision, now),
      decisionId: decision?.opportunityId === args.opportunityId &&
        !(preview.ok && preview.position === "system_loss") ? decision._id : undefined,
      attendanceOwedMeetingIds: meetings.map((meeting) => meeting._id),
    };
  },
});

export const confirmWhopPayment = mutation({
  args: {
    ...approvalArgs,
    opportunityId: previewArgs.opportunityId,
    programId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(paymentTypeValidator),
  },
  returns: providerApplyResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireBillingPermission(ctx, "billing:review");
    await requireBillingOpsEnabled(ctx, actor.tenantId);
    const { tenantId } = actor;
    const now = Date.now();
    const [payment, tenant, deal] = await Promise.all([
      ctx.db.get("providerPayments", args.providerPaymentId),
      ctx.db.get("tenants", tenantId),
      ctx.db.get("opportunities", args.opportunityId),
    ]);
    if (payment?.tenantId !== tenantId || deal?.tenantId !== tenantId || !tenant) return refuse("stale_preview");
    const ready = await findReadyWhopDecision(ctx, payment);
    const kind = deal.outcome === "won" ? "additional_payment" : "payment_win";
    const availableAt = billingAvailableAt(tenant, ready);
    if (modeAtLeastAsk(effectiveKindMode(tenant, kind)) && availableAt !== undefined && now < availableAt) {
      return refuse("not_owner");
    }
    const decisionId = args.decisionId ?? (deal.outcome !== "lost" && ready?.opportunityId === args.opportunityId ? ready._id : undefined);
    return await applyProviderPayment(ctx, {
      ...args, tenantId, now, decisionId, via: "billing", approver: { ...actor, source: "admin" },
    });
  },
});

export const confirmWhopPaymentNoShow = mutation({
  args: {
    ...approvalArgs,
    meetingId: v.id("meetings"),
    amountMinor: v.number(),
    currency: v.string(),
    programId: v.id("tenantPrograms"),
    paymentType: paymentTypeValidator,
    noShowReason: v.optional(noShowReasonValidator),
  },
  returns: providerApplyResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...ROLES]);
    const { tenantId, role, userId } = actor;
    const now = Date.now();
    const [meeting, payment] = await Promise.all([
      ctx.db.get("meetings", args.meetingId), ctx.db.get("providerPayments", args.providerPaymentId),
    ]);
    if (meeting?.tenantId !== tenantId || payment?.tenantId !== tenantId) return refuse("stale_preview");
    const deal = await ctx.db.get("opportunities", meeting.opportunityId);
    if (deal?.tenantId !== tenantId) return refuse("stale_preview");
    if (role === "closer" && deal.assignedCloserId !== userId) {
      throw expectedError("auth.not_your_meeting", "This meeting is assigned to another closer.");
    }
    if (!(payment.paymentRecordId && meeting.status === "no_show")) {
      if (payment.totalMinor !== args.amountMinor || payment.currency !== args.currency) return refuse("amount_mismatch");
      if (meeting.status !== "scheduled" || deal.stage !== "booked" || deal.outcome !== "open") return refuse("stale_preview");
      if (now < meeting.scheduledAt) return refuse("meeting_not_started");
    }
    const ready = await findReadyWhopDecision(ctx, payment);
    const decisionId = args.decisionId ?? ready?._id;
    if (!decisionId && !payment.paymentRecordId) return refuse("stale_preview");
    const result = await applyProviderPayment(ctx, {
      ...args, tenantId, now, opportunityId: deal._id, decisionId,
      approver: { userId, role, source: role === "closer" ? "closer" : "admin" }, via: "meeting_no_show",
    });
    if (!result.ok || result.alreadyApplied) return result;
    const attendance = await recordAttendanceOnlyCore(
      ctx, actor, { meetingId: meeting._id, attendance: "no_show", noShowReason: args.noShowReason, now },
      { fromProviderConfirm: true, noteHumanResult: false },
    );
    if (!attendance.ok) throw new Error("No-show confirmation failed its attendance preflight");
    return result;
  },
});
