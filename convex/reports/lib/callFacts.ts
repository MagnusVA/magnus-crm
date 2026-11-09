import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  createLiveReadState,
  readLiveDocuments,
  readLiveQueryRows,
} from "../../lib/liveQueryBounds";
import { getUserDisplayName } from "../../reporting/lib/helpers";

// The live path is for single days. Stop before per-meeting joins exhaust the
// transaction's index-range budget, and tell the page when a day is partial.
export const CALL_READ_CAP = 300;
export type CallType = "new" | "follow_up";
export type CallStatus =
  | "held"
  | "no_show"
  | "not_recorded"
  | "upcoming"
  | "canceled"
  | "moved";
export type CallEvidence = {
  closerId: Id<"users">;
  moved: boolean;
  rebooked: boolean;
};
export type CallFact = CallEvidence & {
  meeting: Doc<"meetings">;
  closerName: string;
  leadName: string;
  programName: string;
  callType: CallType;
  status: CallStatus;
  due: boolean;
  recordMinutes: number | null;
  standard: boolean;
  dealOutcome: Doc<"opportunities">["outcome"] | null;
};
export type CallFacts = { facts: CallFact[]; partial: boolean };

export function closerAtTheTime(
  meeting: Doc<"meetings">,
  credits: Doc<"dealAttributions">[],
): Id<"users"> {
  const latest = credits
    .filter(
      (row) =>
        row.tenantId === meeting.tenantId &&
        row.meetingId === meeting._id &&
        row.role === "closer",
    )
    .sort(
      (a, b) =>
        b.attributedAt - a.attributedAt ||
        b._creationTime - a._creationTime ||
        b._id.localeCompare(a._id),
    )[0];
  return latest && "userId" in latest.source
    ? latest.source.userId
    : meeting.assignedCloserId;
}

export function callState(
  meeting: Doc<"meetings">,
  evidence: CallEvidence,
  now: number,
) {
  const due =
    meeting.status !== "canceled" &&
    meeting.scheduledAt + meeting.durationMinutes * 60_000 <= now;
  const status: CallStatus = evidence.moved
    ? "moved"
    : meeting.status === "scheduled"
      ? due
        ? "not_recorded"
        : "upcoming"
      : meeting.status;
  const recordedAt = meeting.heldMarkedAt ?? meeting.noShowMarkedAt;
  return {
    status,
    due,
    callType: meeting.callClassification ?? "new",
    recordMinutes:
      recordedAt === undefined
        ? null
        : Math.trunc(
            (recordedAt -
              meeting.scheduledAt -
              meeting.durationMinutes * 60_000) /
              60_000,
          ),
  };
}

export async function readRangeMeetings(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  from: number,
  to: number,
) {
  return await readLiveQueryRows(
    ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("scheduledAt", from)
          .lt("scheduledAt", to),
      ),
    CALL_READ_CAP,
  );
}

/** Bounded live reads for historical credit and current call dimensions. */
export async function loadCallFacts(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  meetings: Doc<"meetings">[],
  now: number,
  evidence?: Map<Id<"meetings">, CallEvidence>,
): Promise<CallFacts> {
  const state = createLiveReadState();
  const owned = meetings.filter((m) => m.tenantId === tenantId);
  const byMeeting = evidence ?? new Map<Id<"meetings">, CallEvidence>();
  if (!evidence) {
    for (const meeting of owned) {
      const credits = await readLiveQueryRows(
        ctx.db
          .query("dealAttributions")
          .withIndex("by_tenantId_and_meetingId", (q) =>
            q.eq("tenantId", tenantId).eq("meetingId", meeting._id),
          ),
        100,
        state,
      );
      // A truncated credit history could silently credit the wrong closer.
      if (credits.capped) break;
      const successor =
        meeting.status === "canceled"
          ? await ctx.db
              .query("meetings")
              .withIndex("by_rescheduledFromMeetingId", (q) =>
                q.eq("rescheduledFromMeetingId", meeting._id),
              )
              .first()
          : null;
      const previous = meeting.rescheduledFromMeetingId
        ? await ctx.db.get("meetings", meeting.rescheduledFromMeetingId)
        : null;
      byMeeting.set(meeting._id, {
        closerId: closerAtTheTime(meeting, credits.rows),
        moved: successor?.tenantId === tenantId,
        rebooked:
          previous?.tenantId === tenantId && previous.status === "no_show",
      });
    }
  }
  const included = owned.filter((m) => byMeeting.has(m._id));
  const deals = await readLiveDocuments(
    [...new Set(included.map((m) => m.opportunityId))].slice(0, 600),
    (id) => ctx.db.get("opportunities", id),
    state,
  );
  const dealById = new Map(
    deals.rows.filter((d) => d.tenantId === tenantId).map((d) => [d._id, d]),
  );
  const closerIds = [
    ...new Set(included.map((m) => byMeeting.get(m._id)!.closerId)),
  ];
  const users = await readLiveDocuments(
    closerIds.slice(0, 500),
    (id) => ctx.db.get("users", id),
    state,
  );
  const userById = new Map(
    users.rows.filter((u) => u.tenantId === tenantId).map((u) => [u._id, u]),
  );
  const configIds = [
    ...new Set(
      deals.rows.flatMap((d) =>
        d.eventTypeConfigId ? [d.eventTypeConfigId] : [],
      ),
    ),
  ];
  const configs = await readLiveDocuments(
    configIds.slice(0, 300),
    (id) => ctx.db.get("eventTypeConfigs", id),
    state,
  );
  const configById = new Map(
    configs.rows.filter((c) => c.tenantId === tenantId).map((c) => [c._id, c]),
  );
  const missingNames = included
    .filter((m) => !m.leadName)
    .flatMap((m) => {
      const deal = dealById.get(m.opportunityId);
      return deal ? [deal.leadId] : [];
    });
  const leads = await readLiveDocuments(
    [...new Set(missingNames)].slice(0, 600),
    (id) => ctx.db.get("leads", id),
    state,
  );
  const leadById = new Map(
    leads.rows.filter((l) => l.tenantId === tenantId).map((l) => [l._id, l]),
  );
  return {
    partial:
      state.capped ||
      included.length !== owned.length ||
      new Set(included.map((m) => m.opportunityId)).size > 600 ||
      closerIds.length > 500 ||
      configIds.length > 300 ||
      new Set(missingNames).size > 600,
    facts: included.map((meeting) => {
      const proof = byMeeting.get(meeting._id)!;
      const deal = dealById.get(meeting.opportunityId);
      return {
        meeting,
        ...proof,
        ...callState(meeting, proof, now),
        closerName: userById.has(proof.closerId)
          ? getUserDisplayName(userById.get(proof.closerId))
          : "Removed closer",
        leadName:
          meeting.leadName ??
          (deal ? leadById.get(deal.leadId)?.fullName : null) ??
          "Unknown person",
        programName: meeting.bookingProgramName ?? "Unknown program",
        // Scheduling mode follows the deal's latest event type.
        standard: !!(
          deal?.eventTypeConfigId &&
          configById.get(deal.eventTypeConfigId)?.isExtended
        ),
        dealOutcome: deal?.outcome ?? null,
      };
    }),
  };
}
