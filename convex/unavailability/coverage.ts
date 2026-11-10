import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { recordCloserReassignment } from "../lib/attribution/dealAttributions";
import { emitDomainEvent } from "../lib/domainEvents";
import { log } from "../lib/observability/log";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import {
  assertCoreRole,
  type CheckResult,
  type CoreActor,
  type Provenance,
  provenanceMetadata,
} from "../lib/outcomeCores";
import { syncOpportunityMeetingsAssignedCloser } from "../lib/syncOpportunityMeetingsAssignedCloser";
import { getEffectiveRange, type UnavailabilityReason } from "../lib/unavailabilityValidation";
import {
  assignmentConflicts,
  type Busy,
  capRefusal,
  COVERAGE_BUFFER_MS,
  COVERAGE_CAPS,
  countPlanMeetings,
  type PlanCandidate,
  type PlanDeal,
  type PlanMeeting,
  slotMeetings,
} from "./planner";
import { getReasonLabel, getUserDisplayName } from "./shared";

/**
 * Coverage plans (docs/plans/admin-assistant.md §4 "Plans"): the reads the
 * planner runs on, and the core that applies a frozen plan. A plan names one
 * new owner per deal and the exact meetings on each deal; applying it never
 * re-runs scoring. It re-lists every deal's meetings, re-checks the caps and
 * each target's calls and absences, then creates the absence and reassigns
 * each deal once, all or nothing.
 */

type Ctx = QueryCtx | MutationCtx;

const HOUR_MS = 60 * 60 * 1000;
/** How far before a call a candidate's longer call could still overlap it. */
const LOOKBACK_MS = 4 * HOUR_MS;
/** Documents one planning or apply pass may read before it refuses. */
export const COVERAGE_READ_BUDGET = 4000;
/** Users scanned to find a workspace's closers when none are named. */
const USER_SCAN_LIMIT = 200;

class ReadBudget {
  reads = 0;
  constructor(private readonly limit = COVERAGE_READ_BUDGET) {}
  get left() {
    return Math.max(0, this.limit - this.reads);
  }
  add(n: number) {
    this.reads += n;
    return this.reads <= this.limit;
  }
}

export type Refusal = { ok: false; code: string; message: string };

/** A plan as frozen at preparation, stored as the committer's arguments. */
export type CoveragePlanArgs = {
  closerId: Id<"users">;
  date: number;
  isFullDay: boolean;
  startTime?: number;
  endTime?: number;
  reason: UnavailabilityReason;
  deals: Array<{
    opportunityId: Id<"opportunities">;
    toCloserId: Id<"users">;
    affectedMeetingIds: Id<"meetings">[];
    meetings: Array<{
      meetingId: Id<"meetings">;
      scheduledAt: number;
      durationMinutes: number;
      status: Doc<"meetings">["status"];
    }>;
  }>;
};

export type CoverageInput = {
  deals: Array<PlanDeal & { personName: string | undefined }>;
  /** Affected deals the source closer no longer owns; left out of the plan. */
  skipped: Array<{ opportunityId: Id<"opportunities">; reason: string }>;
  candidates: PlanCandidate[];
  reads: number;
};

const toPlanMeeting = (m: Doc<"meetings">): PlanMeeting => ({
  meetingId: m._id,
  opportunityId: m.opportunityId,
  scheduledAt: m.scheduledAt,
  durationMinutes: m.durationMinutes,
  status: m.status,
});

async function dealMeetings(ctx: Ctx, opportunityId: Id<"opportunities">, limit: number) {
  return await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .take(limit);
}

/** Windows around the calls that move, merged, to read candidates' schedules in. */
function scheduleWindows(deals: readonly PlanDeal[], now: number): Array<[number, number]> {
  const windows = deals
    .flatMap((d) => slotMeetings(d, now))
    .map((m): [number, number] => [
      m.scheduledAt - COVERAGE_BUFFER_MS - LOOKBACK_MS,
      m.scheduledAt + m.durationMinutes * 60_000 + COVERAGE_BUFFER_MS,
    ])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  return merged;
}

/** Each closer's calls and absences near the calls that move. */
async function loadBusy(
  ctx: Ctx,
  tenantId: Id<"tenants">,
  closers: ReadonlyArray<{ closerId: Id<"users">; name: string }>,
  deals: readonly PlanDeal[],
  now: number,
  budget: ReadBudget,
): Promise<PlanCandidate[] | null> {
  const windows = scheduleWindows(deals, now);
  const out: PlanCandidate[] = [];
  for (const closer of closers) {
    const busy: Busy[] = [];
    const seenAbsences = new Set<Id<"closerUnavailability">>();
    for (const [from, to] of windows) {
      const meetings = await ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
          q.eq("tenantId", tenantId).eq("assignedCloserId", closer.closerId).gte("scheduledAt", from).lt("scheduledAt", to),
        )
        .take(budget.left + 1);
      if (!budget.add(meetings.length)) return null;
      for (const m of meetings) {
        if (m.status !== "scheduled") continue;
        busy.push({ start: m.scheduledAt, end: m.scheduledAt + m.durationMinutes * 60_000, kind: "meeting", opportunityId: m.opportunityId });
      }
      // An absence's `date` is the start of its day, so one that overlaps
      // starts at most a day (and a DST hour) before the window.
      const absences = await ctx.db
        .query("closerUnavailability")
        .withIndex("by_closerId_and_date", (q) =>
          q.eq("closerId", closer.closerId).gte("date", from - 25 * HOUR_MS).lt("date", to),
        )
        .take(budget.left + 1);
      if (!budget.add(absences.length)) return null;
      for (const a of absences) {
        if (a.tenantId !== tenantId || seenAbsences.has(a._id)) continue;
        seenAbsences.add(a._id);
        const range = getEffectiveRange(a);
        busy.push({ start: range.rangeStart, end: range.rangeEnd, kind: "absence" });
      }
    }
    out.push({ closerId: closer.closerId, name: closer.name, busy });
  }
  return out;
}

function isUsableCloser(user: Doc<"users"> | null, tenantId: Id<"tenants">): user is Doc<"users"> {
  return Boolean(user && user.tenantId === tenantId && user.role === "closer" && user.isActive && user.deletedAt === undefined);
}

/**
 * Reads what the planner needs: the closer's scheduled calls in the window,
 * every meeting on each affected deal, and the candidates' calls and
 * absences near the calls that move. Counts its reads and refuses an
 * oversized request before anything is stored.
 */
export async function loadCoverageInput(
  ctx: Ctx,
  args: {
    tenantId: Id<"tenants">;
    closerId: Id<"users">;
    rangeStart: number;
    rangeEnd: number;
    candidateCloserIds?: Id<"users">[];
    now: number;
  },
): Promise<({ ok: true } & CoverageInput) | Refusal> {
  const { tenantId, closerId, now } = args;
  const budget = new ReadBudget();
  const tooBig = (why: string): Refusal => ({ ok: false, code: "coverage.too_large", message: `${why}. Use the redistribute wizard in Magnus for this one.` });

  // 1. The closer's calls in the window. Bounded: anything past this is
  //    over the caps anyway.
  const windowMeetings = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
      q.eq("tenantId", tenantId).eq("assignedCloserId", closerId).gte("scheduledAt", args.rangeStart).lt("scheduledAt", args.rangeEnd),
    )
    .take(COVERAGE_CAPS.meetings * 4 + 1);
  budget.add(windowMeetings.length);
  if (windowMeetings.length > COVERAGE_CAPS.meetings * 4) return tooBig("This window holds too many calls");
  const affected = windowMeetings.filter((m) => m.status === "scheduled").sort((a, b) => a.scheduledAt - b.scheduledAt);
  const affectedByDeal = new Map<Id<"opportunities">, Doc<"meetings">[]>();
  for (const m of affected) affectedByDeal.set(m.opportunityId, [...(affectedByDeal.get(m.opportunityId) ?? []), m]);
  const sizeFirst = capRefusal({ meetings: affected.length, deals: affectedByDeal.size, candidates: 0 });
  if (sizeFirst) return tooBig(sizeFirst);

  // 2. Every meeting on each deal: they all move with it.
  const deals: CoverageInput["deals"] = [];
  const skipped: CoverageInput["skipped"] = [];
  let moving = 0;
  for (const [opportunityId, inWindow] of affectedByDeal) {
    const deal = await ctx.db.get("opportunities", opportunityId);
    budget.add(1);
    if (!deal || deal.tenantId !== tenantId) {
      skipped.push({ opportunityId, reason: "Deal not found" });
      continue;
    }
    if (deal.assignedCloserId !== closerId) {
      skipped.push({ opportunityId, reason: "The deal belongs to another closer" });
      continue;
    }
    const meetings = await dealMeetings(ctx, opportunityId, COVERAGE_CAPS.meetings - moving + 1);
    budget.add(meetings.length);
    moving += meetings.length;
    if (moving > COVERAGE_CAPS.meetings) return tooBig(capRefusal({ meetings: moving, deals: 0, candidates: 0 })!);
    deals.push({
      opportunityId,
      meetings: meetings.map(toPlanMeeting).sort((a, b) => a.scheduledAt - b.scheduledAt),
      affectedMeetingIds: inWindow.map((m) => m._id),
      personName: inWindow[0]?.leadName,
    });
  }

  // 3. The candidates: named, or every active closer when there are few.
  let closers: Doc<"users">[];
  if (args.candidateCloserIds) {
    const ids = [...new Set(args.candidateCloserIds)].filter((id) => id !== closerId);
    const sized = capRefusal({ meetings: 0, deals: 0, candidates: ids.length });
    if (sized) return tooBig(sized);
    closers = [];
    for (const id of ids) {
      const user = await ctx.db.get("users", id);
      budget.add(1);
      if (!isUsableCloser(user, tenantId)) {
        return { ok: false, code: "coverage.candidate_invalid", message: "One of the candidates isn't an active closer in this workspace." };
      }
      closers.push(user);
    }
  } else {
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_isActive", (q) => q.eq("tenantId", tenantId).eq("isActive", true))
      .take(USER_SCAN_LIMIT);
    budget.add(users.length);
    closers = users.filter((u) => u._id !== closerId && isUsableCloser(u, tenantId));
    if (closers.length > COVERAGE_CAPS.candidates) {
      return {
        ok: false,
        code: "coverage.too_many_candidates",
        message: `This workspace has ${closers.length} other closers. Name up to ${COVERAGE_CAPS.candidates} with candidateCloserIds, or use the redistribute wizard in Magnus.`,
      };
    }
  }

  // 4. Their calls and absences near the calls that move.
  const candidates = await loadBusy(
    ctx,
    tenantId,
    closers.map((u) => ({ closerId: u._id, name: getUserDisplayName(u) })),
    deals,
    now,
    budget,
  );
  if (!candidates) return tooBig("The candidates' schedules are too large to check here");
  return { ok: true, deals, skipped, candidates, reads: budget.reads };
}

/** The source closer's absences around the plan's date. */
async function sourceAbsences(ctx: Ctx, args: CoveragePlanArgs) {
  return await ctx.db
    .query("closerUnavailability")
    .withIndex("by_closerId_and_date", (q) =>
      q.eq("closerId", args.closerId).gte("date", args.date - 24 * HOUR_MS).lte("date", args.date + 24 * HOUR_MS),
    )
    .take(20);
}

/**
 * The values a coverage plan depends on: each deal's owner, the exact set of
 * meetings on it with each one's start, duration and status, and the source
 * closer's absences.
 */
export async function coveragePlanPins(
  ctx: Ctx,
  tenantId: Id<"tenants">,
  args: CoveragePlanArgs,
): Promise<Record<string, string | number | null>> {
  const pins: Record<string, string | number | null> = {};
  for (const d of args.deals) {
    const deal = await ctx.db.get("opportunities", d.opportunityId);
    if (!deal || deal.tenantId !== tenantId) {
      pins[`deal:${d.opportunityId}`] = "missing";
      continue;
    }
    pins[`deal:${d.opportunityId}.assignedCloserId`] = deal.assignedCloserId ?? null;
    const meetings = await dealMeetings(ctx, d.opportunityId, COVERAGE_CAPS.meetings + 1);
    pins[`deal:${d.opportunityId}.meetings`] = meetings.map((m) => m._id).sort().join(",");
    for (const m of meetings) {
      pins[`meeting:${m._id}.scheduledAt`] = m.scheduledAt;
      pins[`meeting:${m._id}.durationMinutes`] = m.durationMinutes;
      pins[`meeting:${m._id}.status`] = m.status;
    }
  }
  pins[`closer:${args.closerId}.absences`] = (await sourceAbsences(ctx, args))
    .map((a) => a._id)
    .sort()
    .join(",");
  return pins;
}

function frozenDeals(args: CoveragePlanArgs): PlanDeal[] {
  return args.deals.map((d) => ({
    opportunityId: d.opportunityId,
    affectedMeetingIds: d.affectedMeetingIds,
    meetings: d.meetings.map((m) => ({ ...m, opportunityId: d.opportunityId })),
  }));
}

/**
 * Everything a coverage plan needs to still hold, without writing: the caps,
 * the source closer and their day, each deal's owner and exact meetings, and
 * each target's status, calls and absences. Never re-scores.
 */
export async function checkCoveragePlan(
  ctx: Ctx,
  actor: CoreActor,
  args: CoveragePlanArgs,
  now = Date.now(),
): Promise<CheckResult<object>> {
  const refuse = (code: string, message: string): Refusal => ({ ok: false, code, message });
  const deals = frozenDeals(args);
  const targetIds = [...new Set(args.deals.map((d) => d.toCloserId))];
  const sized = capRefusal({ meetings: countPlanMeetings(deals), deals: deals.length, candidates: targetIds.length });
  if (sized) return refuse("coverage.too_large", `${sized}.`);
  if (!args.isFullDay && (args.startTime === undefined || args.endTime === undefined || args.startTime >= args.endTime)) {
    return refuse("coverage.window_invalid", "The absence needs a start before its end.");
  }

  const source = await ctx.db.get("users", args.closerId);
  if (!source || source.tenantId !== actor.tenantId || source.role !== "closer") {
    return refuse("coverage.closer_missing", "That closer is no longer in this workspace.");
  }
  const sameDay = await ctx.db
    .query("closerUnavailability")
    .withIndex("by_closerId_and_date", (q) => q.eq("closerId", args.closerId).eq("date", args.date))
    .first();
  if (sameDay) {
    return refuse("coverage.absence_exists", `${getUserDisplayName(source)} already has an absence that day. Open it in the redistribute wizard.`);
  }

  const budget = new ReadBudget();
  for (const d of args.deals) {
    if (d.toCloserId === args.closerId) return refuse("coverage.target_invalid", "A deal can't be covered by the absent closer.");
    const deal = await ctx.db.get("opportunities", d.opportunityId);
    if (!deal || deal.tenantId !== actor.tenantId) return refuse("coverage.stale", "A deal in this plan no longer exists.");
    if (deal.assignedCloserId !== args.closerId) return refuse("coverage.stale", "A deal in this plan has moved to another closer.");
    const current = await dealMeetings(ctx, d.opportunityId, COVERAGE_CAPS.meetings + 1);
    budget.add(current.length + 1);
    const frozen = new Map(d.meetings.map((m) => [m.meetingId, m]));
    const drifted =
      current.length !== frozen.size ||
      current.some((m) => {
        const f = frozen.get(m._id);
        return !f || f.scheduledAt !== m.scheduledAt || f.durationMinutes !== m.durationMinutes || f.status !== m.status;
      });
    if (drifted) {
      return refuse("coverage.stale", "A call on one of these deals was added, removed, moved or resized since the plan was made.");
    }
  }

  const targets: Array<{ closerId: Id<"users">; name: string }> = [];
  for (const id of targetIds) {
    const user = await ctx.db.get("users", id);
    if (!isUsableCloser(user, actor.tenantId)) {
      return refuse("coverage.target_inactive", `${user ? getUserDisplayName(user) : "A chosen closer"} is no longer an active closer.`);
    }
    targets.push({ closerId: id, name: getUserDisplayName(user) });
  }
  const busy = await loadBusy(ctx, actor.tenantId, targets, deals, now, budget);
  if (!busy) return refuse("coverage.too_large", "The chosen closers' schedules grew too large to check here. Use the redistribute wizard.");
  const conflicts = assignmentConflicts({
    deals,
    targets: busy,
    assignments: args.deals.map((d) => ({ opportunityId: d.opportunityId, toCloserId: d.toCloserId })),
    now,
  });
  if (conflicts.length) {
    const c = conflicts[0];
    const who = targets.find((t) => t.closerId === c.toCloserId)?.name ?? "A chosen closer";
    return refuse(
      "coverage.target_busy",
      `${who} is ${c.kind === "absence" ? "now marked absent" : "now booked"} at the time of a call in this plan. Ask your assistant for a new plan.`,
    );
  }
  return { ok: true };
}

/**
 * Applies a frozen coverage plan as `actor`: creates the absence as the web's
 * create-unavailability mutation does, then reassigns each deal once through
 * the web's helpers. Refuses with no writes when anything drifted.
 */
export async function applyCoveragePlanCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: CoveragePlanArgs,
  provenance: Provenance,
): Promise<{
  unavailabilityId: Id<"closerUnavailability">;
  reassignedDeals: number;
  movedMeetings: number;
}> {
  assertCoreRole(actor, ["tenant_master", "tenant_admin"]);
  const check = await checkCoveragePlan(ctx, actor, args);
  if (!check.ok) throw new Error(check.message);

  const now = Date.now();
  const { tenantId, userId } = actor;
  const unavailabilityId = await ctx.db.insert("closerUnavailability", {
    tenantId,
    closerId: args.closerId,
    date: args.date,
    startTime: args.isFullDay ? undefined : args.startTime,
    endTime: args.isFullDay ? undefined : args.endTime,
    isFullDay: args.isFullDay,
    reason: args.reason,
    createdByUserId: userId,
    createdAt: now,
  });
  const affectedCount = args.deals.reduce((n, d) => n + d.affectedMeetingIds.length, 0);
  log.info("unavailability.created", {
    tenantId,
    closerId: args.closerId,
    unavailabilityId,
    reason: args.reason,
    isFullDay: args.isFullDay,
    affectedMeetingCount: affectedCount,
  });

  const reasonLabel = getReasonLabel(args.reason);
  let movedMeetings = 0;
  for (const d of args.deals) {
    const fromCloserId = args.closerId;
    await patchOpportunityLifecycle(ctx, d.opportunityId, { assignedCloserId: d.toCloserId, updatedAt: now });
    movedMeetings += await syncOpportunityMeetingsAssignedCloser(ctx, d.opportunityId, d.toCloserId);
    let first: Doc<"meetings"> | null = null;
    for (const meetingId of d.affectedMeetingIds) {
      const meeting = await ctx.db.get("meetings", meetingId);
      if (!meeting) continue;
      first ??= meeting;
      await ctx.db.patch("meetings", meetingId, { reassignedFromCloserId: fromCloserId });
      await ctx.db.insert("meetingReassignments", {
        tenantId,
        meetingId,
        opportunityId: d.opportunityId,
        fromCloserId,
        toCloserId: d.toCloserId,
        reason: `${reasonLabel} - coverage plan`,
        unavailabilityId,
        reassignedByUserId: userId,
        reassignedAt: now,
      });
    }
    await recordCloserReassignment(ctx, {
      tenantId,
      opportunityId: d.opportunityId,
      meeting: first ?? undefined,
      toUserId: d.toCloserId,
      fromUserId: fromCloserId,
      at: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: d.opportunityId,
      eventType: "opportunity.reassigned",
      source: "admin",
      actorUserId: userId,
      metadata: {
        fromCloserId,
        toCloserId: d.toCloserId,
        meetingId: first?._id,
        meetingIds: d.affectedMeetingIds,
        unavailabilityId,
        mode: "coverage_plan",
        ...provenanceMetadata(provenance),
      },
      occurredAt: now,
    });
  }

  log.info("unavailability.coverage_plan.applied", {
    tenantId,
    unavailabilityId,
    fromCloserId: args.closerId,
    dealCount: args.deals.length,
    movedMeetingCount: movedMeetings,
    via: provenance.via,
  });
  return { unavailabilityId, reassignedDeals: args.deals.length, movedMeetings };
}
