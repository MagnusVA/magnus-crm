import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { noteHumanResult } from "../automation/humanResult";
import { earliestCountingPayment, readDealPayments } from "../lib/enrollments";
import { emitDomainEvent } from "../lib/domainEvents";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { expectedError } from "../lib/observability/errors";
import { assertCoreRole, type CoreActor } from "../lib/outcomeCores";
import { isWonDeal } from "../opportunities/dealGuards";
import { readActiveAllocation } from "../payments/allocation";
import { paymentCommandRefusalValidator, refuse, type PaymentCommandResult } from "../payments/commandResult";
import { requireTenantUser } from "../requireTenantUser";
import { noShowReasonValidator, type NoShowReason } from "./noShowActions";

const ROLES = ["closer", "tenant_master", "tenant_admin"] as const;
const attendanceOnlyResultValidator = v.union(
  paymentCommandRefusalValidator,
  v.object({ ok: v.literal(true), alreadyApplied: v.boolean(), alreadyRecorded: v.boolean() }),
);
type AttendanceArgs = {
  meetingId: Id<"meetings">;
  attendance: "held" | "no_show";
  noShowReason?: NoShowReason;
  now: number;
};

export async function recordAttendanceOnlyCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: AttendanceArgs,
  opts: { fromProviderConfirm: boolean; noteHumanResult: boolean },
): Promise<PaymentCommandResult<{ alreadyRecorded: boolean }>> {
  assertCoreRole(actor, ROLES);
  const { meetingId, attendance, noShowReason, now } = args;
  const meeting = await ctx.db.get("meetings", meetingId);
  if (meeting?.tenantId !== actor.tenantId) return refuse("stale_preview");
  const deal = await ctx.db.get("opportunities", meeting.opportunityId);
  if (deal?.tenantId !== actor.tenantId) return refuse("stale_preview");
  if (actor.role === "closer" && deal.assignedCloserId !== actor.userId) {
    throw expectedError("auth.not_your_meeting", "This meeting is assigned to another closer.");
  }
  if (!isWonDeal(deal)) return refuse("attendance_not_owed");
  if (meeting.status === attendance) return { ok: true, alreadyApplied: true, alreadyRecorded: true };
  if (meeting.status !== "scheduled" || (!opts.fromProviderConfirm && meeting.attendanceOwedSince === undefined)) {
    return refuse("attendance_not_owed");
  }
  if (now < meeting.scheduledAt) return refuse("meeting_not_started");
  if (!opts.fromProviderConfirm) {
    const firstPayment = earliestCountingPayment(await readDealPayments(ctx, deal._id));
    const payment = firstPayment?.providerPaymentId && await ctx.db.get("providerPayments", firstPayment.providerPaymentId);
    if (firstPayment?.tenantId !== actor.tenantId || firstPayment.origin !== "provider" ||
        !payment || payment.tenantId !== actor.tenantId ||
        (await readActiveAllocation(ctx, payment))?._id !== firstPayment._id) return refuse("attendance_not_owed");
  }

  const source = actor.role === "closer" ? "closer" : "admin";
  const extraMeetingPatch: Partial<Doc<"meetings">> = { attendanceOwedSince: undefined };
  if (attendance === "no_show") {
    extraMeetingPatch.noShowMarkedAt = now;
    extraMeetingPatch.noShowMarkedByUserId = actor.userId;
    extraMeetingPatch.noShowSource = source === "admin" ? "admin_manual" : "closer";
    extraMeetingPatch.noShowReason = noShowReason;
  }
  await completeMeetingForOutcome(ctx, {
    meetingId, opportunityId: deal._id, toMeetingStatus: attendance, recordedAt: now, extraMeetingPatch,
  });
  if (attendance === "no_show") {
    await emitDomainEvent(ctx, {
      tenantId: actor.tenantId, entityType: "meeting", entityId: meetingId,
      eventType: "meeting.no_show", source, actorUserId: actor.userId,
      fromStatus: meeting.status, toStatus: attendance, reason: noShowReason, occurredAt: now,
    });
  }
  if (opts.noteHumanResult) await noteHumanResult(ctx, deal._id, actor);
  return { ok: true, alreadyApplied: false, alreadyRecorded: false };
}

export const recordAttendanceOnly = mutation({
  args: {
    meetingId: v.id("meetings"),
    attendance: v.union(v.literal("held"), v.literal("no_show")),
    noShowReason: v.optional(noShowReasonValidator),
  },
  returns: attendanceOnlyResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...ROLES]);
    return await recordAttendanceOnlyCore(ctx, actor, { ...args, now: Date.now() }, {
      fromProviderConfirm: false, noteHumanResult: true,
    });
  },
});
