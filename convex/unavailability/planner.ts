import type { Doc, Id } from "../_generated/dataModel";

/**
 * The coverage planner (docs/plans/admin-assistant.md §2 tool 13, §4 "Plans").
 *
 * A pure function over data the caller loads. It gives each affected deal ONE
 * new owner who is free for every meeting that moves with it: a reassignment
 * moves every meeting on a deal (`lib/syncOpportunityMeetingsAssignedCloser`),
 * so choosing a closer per meeting, as the redistribute wizard does, could
 * split a deal and let the last choice win. The wizard keeps its own scoring;
 * this planner is tested on its own rules, not pinned to it.
 */

/** A plan's size limits: meetings count every meeting that moves with its deal. */
export const COVERAGE_CAPS = { meetings: 50, deals: 25, candidates: 8 } as const;

/** The gap the wizard keeps around a closer's other calls. */
export const COVERAGE_BUFFER_MS = 15 * 60 * 1000;

export type PlanMeeting = {
  meetingId: Id<"meetings">;
  opportunityId: Id<"opportunities">;
  scheduledAt: number;
  durationMinutes: number;
  status: Doc<"meetings">["status"];
};

export type PlanDeal = {
  opportunityId: Id<"opportunities">;
  /** Every meeting on the deal; all of them move with it. */
  meetings: PlanMeeting[];
  /** The source closer's meetings in the absence window. */
  affectedMeetingIds: Id<"meetings">[];
};

export type Busy = {
  start: number;
  end: number;
  kind: "meeting" | "absence";
  /** For a meeting: its deal, so a deal's own meetings never block it. */
  opportunityId?: Id<"opportunities">;
};

export type PlanCandidate = {
  closerId: Id<"users">;
  name: string;
  /** Meetings (without the buffer) and absences, near the meetings that move. */
  busy: Busy[];
};

export type DealAssignment = {
  opportunityId: Id<"opportunities">;
  toCloserId: Id<"users">;
};

export type CoverageResult = {
  assigned: DealAssignment[];
  unassigned: Array<{ opportunityId: Id<"opportunities">; reason: string }>;
  /** Per candidate: the deals they are free for before anything is assigned. */
  candidates: Array<{ closerId: Id<"users">; name: string; freeFor: Id<"opportunities">[] }>;
};

const end = (m: PlanMeeting) => m.scheduledAt + m.durationMinutes * 60 * 1000;

/** A meeting that still needs a closer to turn up: scheduled and not over. */
export function needsSlot(meeting: PlanMeeting, now: number): boolean {
  return meeting.status === "scheduled" && end(meeting) > now;
}

/** The meetings on a deal a new owner must be free for. */
export function slotMeetings(deal: PlanDeal, now: number): PlanMeeting[] {
  return deal.meetings.filter((m) => needsSlot(m, now));
}

/** The first meeting that conflicts for this closer, or null when they are free for all. */
export function firstConflict(
  busy: readonly Busy[],
  deal: PlanDeal,
  now: number,
): { meeting: PlanMeeting; with: Busy } | null {
  for (const meeting of slotMeetings(deal, now)) {
    const start = meeting.scheduledAt;
    const finish = end(meeting);
    for (const b of busy) {
      if (b.kind === "meeting" && b.opportunityId === deal.opportunityId) continue;
      const pad = b.kind === "meeting" ? COVERAGE_BUFFER_MS : 0;
      if (start < b.end + pad && finish > b.start - pad) return { meeting, with: b };
    }
  }
  return null;
}

export function countPlanMeetings(deals: readonly PlanDeal[]): number {
  return deals.reduce((n, d) => n + d.meetings.length, 0);
}

/** Why a plan of this size is refused, or null when it fits. */
export function capRefusal(sizes: { meetings: number; deals: number; candidates: number }): string | null {
  if (sizes.deals > COVERAGE_CAPS.deals) return `${sizes.deals} deals are affected; a plan covers at most ${COVERAGE_CAPS.deals}`;
  if (sizes.meetings > COVERAGE_CAPS.meetings)
    return `${sizes.meetings} meetings would move with their deals; a plan moves at most ${COVERAGE_CAPS.meetings}`;
  if (sizes.candidates > COVERAGE_CAPS.candidates)
    return `${sizes.candidates} closers to choose from; a plan considers at most ${COVERAGE_CAPS.candidates}`;
  return null;
}

/**
 * Assigns each deal one owner, free for every meeting that moves. Deals with
 * the fewest free candidates go first, then by their first such meeting;
 * among free candidates the one with the fewest calls nearby wins, then by
 * name. A deal no one is free for stays
 * unassigned with the reason. Never splits a deal.
 */
export function planCoverage(input: { deals: readonly PlanDeal[]; candidates: readonly PlanCandidate[]; now: number }): CoverageResult {
  const { now } = input;
  const busy = new Map(input.candidates.map((c) => [c.closerId, [...c.busy]]));
  const load = new Map(input.candidates.map((c) => [c.closerId, c.busy.filter((b) => b.kind === "meeting").length]));
  const candidates = [...input.candidates].sort((a, b) => a.name.localeCompare(b.name) || a.closerId.localeCompare(b.closerId));

  const freeBefore = candidates.map((c) => ({
    closerId: c.closerId,
    name: c.name,
    freeFor: input.deals.filter((d) => !firstConflict(c.busy, d, now)).map((d) => d.opportunityId),
  }));

  // The deals fewest closers are free for go first, so an easy deal never
  // takes the only closer a hard one could have had.
  const choices = new Map(input.deals.map((d) => [d.opportunityId, freeBefore.filter((c) => c.freeFor.includes(d.opportunityId)).length]));
  const firstStart = (d: PlanDeal) => Math.min(...slotMeetings(d, now).map((m) => m.scheduledAt), Number.POSITIVE_INFINITY);
  const deals = [...input.deals].sort(
    (a, b) =>
      choices.get(a.opportunityId)! - choices.get(b.opportunityId)! ||
      firstStart(a) - firstStart(b) ||
      a.opportunityId.localeCompare(b.opportunityId),
  );

  const assigned: DealAssignment[] = [];
  const unassigned: CoverageResult["unassigned"] = [];
  for (const deal of deals) {
    let best: PlanCandidate | null = null;
    for (const c of candidates) {
      if (firstConflict(busy.get(c.closerId)!, deal, now)) continue;
      if (!best || load.get(c.closerId)! < load.get(best.closerId)!) best = c;
    }
    if (!best) {
      unassigned.push({
        opportunityId: deal.opportunityId,
        reason: candidates.length ? "No candidate is free for every call on this deal" : "No candidate closers",
      });
      continue;
    }
    const slots = slotMeetings(deal, now);
    busy.get(best.closerId)!.push(
      ...slots.map((m) => ({ start: m.scheduledAt, end: end(m), kind: "meeting" as const, opportunityId: m.opportunityId })),
    );
    load.set(best.closerId, load.get(best.closerId)! + slots.length);
    assigned.push({ opportunityId: deal.opportunityId, toCloserId: best.closerId });
  }
  return { assigned, unassigned, candidates: freeBefore };
}

/**
 * Re-checks fixed assignments without scoring: each target must still be free
 * for its deal's meetings, counting the other deals the plan gives them.
 */
export function assignmentConflicts(input: {
  deals: readonly PlanDeal[];
  targets: readonly PlanCandidate[];
  assignments: readonly DealAssignment[];
  now: number;
}): Array<{ opportunityId: Id<"opportunities">; toCloserId: Id<"users">; meeting: PlanMeeting; kind: Busy["kind"] }> {
  const byTarget = new Map(input.targets.map((t) => [t.closerId, t]));
  const dealById = new Map(input.deals.map((d) => [d.opportunityId, d]));
  const conflicts = [];
  for (const a of input.assignments) {
    const deal = dealById.get(a.opportunityId);
    const target = byTarget.get(a.toCloserId);
    if (!deal || !target) continue;
    const others: Busy[] = input.assignments
      .filter((o) => o.toCloserId === a.toCloserId && o.opportunityId !== a.opportunityId)
      .flatMap((o) => slotMeetings(dealById.get(o.opportunityId)!, input.now))
      .map((m) => ({ start: m.scheduledAt, end: end(m), kind: "meeting" as const, opportunityId: m.opportunityId }));
    const hit = firstConflict([...target.busy, ...others], deal, input.now);
    if (hit) conflicts.push({ opportunityId: a.opportunityId, toCloserId: a.toCloserId, meeting: hit.meeting, kind: hit.with.kind });
  }
  return conflicts;
}
