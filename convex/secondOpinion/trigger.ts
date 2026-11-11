import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { claimFor, type CallRecord } from "./questions";
import { JEV_MODEL } from "./jev";
import { isPlaceholderEmail, normalizeEmail } from "../lib/normalization";
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

/**
 * True when the recording's calendar invitees name someone outside the team
 * and none of them is this meeting's prospect: the recording is another
 * person's call, matched by time alone. A prospect with no known email, or a
 * recording with no outside invitee, can't be compared and isn't flagged.
 */
export async function isOtherProspectsCall(
  ctx: QueryCtx | MutationCtx,
  meeting: Doc<"meetings">,
  recording: Doc<"callRecordings">,
): Promise<boolean> {
  const deal = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!deal || deal.tenantId !== meeting.tenantId) return false;
  const lead = await ctx.db.get("leads", deal.leadId);
  const identifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", deal.leadId))
    .take(50);
  const leadEmails = new Set(
    [
      lead?.email,
      ...identifiers.filter((i) => i.type === "email").map((i) => i.value),
    ]
      .map((email) => (email ? normalizeEmail(email) : undefined))
      .filter((email): email is string => Boolean(email)),
  );
  if (leadEmails.size === 0) return false;
  const recorder = recording.recordedByEmail.toLowerCase();
  let outside = 0;
  for (const raw of recording.inviteeEmails.slice(0, 20)) {
    const email = normalizeEmail(raw);
    if (!email || email === recorder || isPlaceholderEmail(email)) continue;
    if (leadEmails.has(email)) return false;
    const staff = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", meeting.tenantId).eq("email", email),
      )
      .first();
    if (!staff) outside++;
  }
  return outside > 0;
}

async function insertCheck(
  ctx: MutationCtx,
  args: {
    meeting: Doc<"meetings">;
    recording: Doc<"callRecordings">;
    trigger: SecondOpinionTrigger;
    inputKey: string;
    record: CallRecord | undefined;
    rerun?: { of: Id<"secondOpinions">; by: Id<"users"> };
  },
): Promise<Id<"secondOpinions">> {
  const otherProspect = await isOtherProspectsCall(ctx, args.meeting, args.recording);
  const id = await ctx.db.insert("secondOpinions", {
    tenantId: args.meeting.tenantId,
    meetingId: args.meeting._id,
    recordingId: args.recording._id,
    closerUserId: args.meeting.assignedCloserId,
    trigger: args.trigger,
    record: args.record,
    claim: claimFor(args.record),
    inputKey: args.inputKey,
    model: JEV_MODEL,
    status: otherProspect ? "skipped" : "queued",
    ...(otherProspect ? { failure: "other_prospect" as const } : {}),
    attempts: 0,
    ...(args.rerun
      ? { rerunOf: args.rerun.of, requestedByUserId: args.rerun.by }
      : {}),
    createdAt: Date.now(),
  });
  if (!otherProspect)
    await ctx.scheduler.runAfter(0, internal.secondOpinion.run.run, {
      secondOpinionId: id,
      attempt: 0,
    });
  return id;
}

/** The matched recording a check can read, or null. */
async function readableRecording(
  ctx: MutationCtx,
  meeting: Doc<"meetings">,
): Promise<Doc<"callRecordings"> | null> {
  const recording = await ctx.db
    .query("callRecordings")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
    .first();
  if (
    !recording ||
    recording.tenantId !== meeting.tenantId ||
    recording.matchStatus !== "matched" ||
    !recording.transcriptStorageId ||
    recording.transcriptDeletedAt !== undefined ||
    recording.recordingStartAt + 90 * 86400_000 <= Date.now()
  )
    return null;
  return recording;
}

/**
 * Runs a check again for an owner or admin: a new row against the meeting's
 * current record and recording, replacing `previous`, which leaves the
 * review queue and the month's counts but keeps its review. Returns null
 * when there is nothing to check: no readable recording, or no result and
 * the business day still open.
 */
export async function queueRerun(
  ctx: MutationCtx,
  {
    previous,
    requestedByUserId,
  }: { previous: Doc<"secondOpinions">; requestedByUserId: Id<"users"> },
): Promise<Id<"secondOpinions"> | null> {
  const meeting = await ctx.db.get("meetings", previous.meetingId);
  if (!meeting || meeting.tenantId !== previous.tenantId) return null;
  const tenant = await ctx.db.get("tenants", meeting.tenantId);
  if (!tenant?.secondOpinion || tenant.secondOpinion.mode === "off") return null;
  const recording = await readableRecording(ctx, meeting);
  if (!recording) return null;
  const record = hasResult(meeting) ? await snapshotRecord(ctx, meeting) : undefined;
  if (
    !record &&
    !(meeting.status === "scheduled" && businessDayClosed(meeting, tenant, Date.now()))
  )
    return null;
  const now = Date.now();
  const id = await insertCheck(ctx, {
    meeting,
    recording,
    trigger: "rerun",
    inputKey: `${meeting._id}:${recording._id}:rerun:${now}`,
    record,
    rerun: { of: previous._id, by: requestedByUserId },
  });
  await ctx.db.patch("secondOpinions", previous._id, {
    supersededById: id,
    supersededAt: now,
    ...(previous.reviewState === "open" ? { reviewState: undefined } : {}),
  });
  return id;
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
  const recording = await readableRecording(ctx, meeting);
  if (!recording) return null;
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
  return await insertCheck(ctx, { meeting, recording, trigger, inputKey, record });
}
