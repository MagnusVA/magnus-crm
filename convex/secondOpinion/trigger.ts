import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { claimFor, type CallRecord } from "./questions";
import { JEV_MODEL } from "./jev";
import {
  businessDateForInstant,
  businessDayRange,
} from "../../lib/businessDay";

export type SecondOpinionTrigger = Doc<"secondOpinions">["trigger"];

/** Attendance is recorded by a person, never inferred from the recording. */
export function hasResult(meeting: Doc<"meetings">): boolean {
  return meeting.status === "held" || meeting.status === "no_show";
}

export function businessDayClosed(
  meeting: Doc<"meetings">,
  tenant: Doc<"tenants">,
  now: number,
): boolean {
  const date = businessDateForInstant(meeting.scheduledAt, tenant.businessDay);
  return businessDayRange(date, tenant.businessDay).end <= now;
}

/**
 * The result recorded for THIS meeting, never just the deal's latest state: a
 * first call recorded as a call-back stays a call-back even when a later call
 * on the same deal is paid before its recording arrives. Each core ties its
 * result to the meeting: a payment carries `meetingId`, a call-back carries
 * `sourceMeetingId`, and a meeting's loss writes `lostAt` in the same
 * transaction that sets the meeting's `heldMarkedAt`. No match, no check.
 */
async function snapshotRecord(
  ctx: QueryCtx | MutationCtx,
  meeting: Doc<"meetings">,
): Promise<CallRecord | undefined> {
  if (meeting.status === "no_show") return { kind: "no_show" };
  if (meeting.status !== "held") return undefined;
  const deal = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!deal || deal.tenantId !== meeting.tenantId) return undefined;

  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", deal._id))
    .order("desc")
    .take(50);
  const payment = payments.find(
    (p) => p.tenantId === meeting.tenantId && p.meetingId === meeting._id && p.status !== "disputed",
  );
  if (payment)
    return {
      kind: "payment",
      paymentType: payment.paymentType,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    };

  if (
    deal.outcome === "lost" &&
    deal.lostAt !== undefined &&
    meeting.heldMarkedAt !== undefined &&
    Math.abs(deal.lostAt - meeting.heldMarkedAt) < 1000
  )
    return { kind: "lost", lossReason: deal.lostReason };

  const tasks = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", deal._id))
    .take(50);
  if (tasks.some((task) => task.sourceMeetingId === meeting._id && task.type === "manual_reminder"))
    return { kind: "call_back" };
  return undefined;
}

/** Shared mutation core for result writers, Fathom matches and the day-close sweep. */
export async function queueSecondOpinion(
  ctx: MutationCtx,
  {
    meetingId,
    trigger,
  }: { meetingId: Id<"meetings">; trigger: SecondOpinionTrigger },
): Promise<Id<"secondOpinions"> | null> {
  const meeting = await ctx.db.get("meetings", meetingId);
  if (!meeting) return null;
  const tenant = await ctx.db.get("tenants", meeting.tenantId);
  if (!tenant?.secondOpinion || tenant.secondOpinion.mode === "off")
    return null;
  const dayClosed = trigger === "day_closed";
  if (
    dayClosed
      ? meeting.status !== "scheduled" ||
        !businessDayClosed(meeting, tenant, Date.now())
      : !hasResult(meeting)
  )
    return null;
  const recording = await ctx.db
    .query("callRecordings")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
    .first();
  if (
    !recording ||
    recording.tenantId !== tenant._id ||
    recording.matchStatus !== "matched" ||
    !recording.transcriptStorageId ||
    recording.transcriptDeletedAt !== undefined ||
    recording.recordingStartAt + 90 * 86400_000 <= Date.now()
  )
    return null;
  const inputKey = `${meetingId}:${recording._id}`;
  if (
    await ctx.db
      .query("secondOpinions")
      .withIndex("by_tenantId_and_inputKey", (q) =>
        q.eq("tenantId", tenant._id).eq("inputKey", inputKey),
      )
      .first()
  )
    return null;
  const record = dayClosed ? undefined : await snapshotRecord(ctx, meeting);
  if (!dayClosed && !record) return null;
  const id = await ctx.db.insert("secondOpinions", {
    tenantId: tenant._id,
    meetingId,
    recordingId: recording._id,
    closerUserId: meeting.assignedCloserId,
    trigger,
    record,
    claim: claimFor(record),
    inputKey,
    model: JEV_MODEL,
    status: "queued",
    attempts: 0,
    createdAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.secondOpinion.run.run, {
    secondOpinionId: id,
    attempt: 0,
  });
  return id;
}
