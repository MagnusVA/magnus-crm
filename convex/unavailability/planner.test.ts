import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  assignmentConflicts,
  capRefusal,
  COVERAGE_CAPS,
  type PlanCandidate,
  type PlanDeal,
  planCoverage,
} from "./planner";

// The coverage planner's own rules (admin assistant, commit 18): one new
// owner per deal, free for every meeting that moves with it. It is not
// pinned to the redistribute wizard, which scores each meeting alone.

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 9, 12);
const AT = (h: number) => NOW + 24 * HOUR + h * HOUR;

const deal = (id: string, starts: number[], status: "scheduled" | "held" = "scheduled"): PlanDeal => ({
  opportunityId: id as Id<"opportunities">,
  affectedMeetingIds: [`${id}-m0` as Id<"meetings">],
  meetings: starts.map((at, i) => ({
    meetingId: `${id}-m${i}` as Id<"meetings">,
    opportunityId: id as Id<"opportunities">,
    scheduledAt: at,
    durationMinutes: 30,
    status,
  })),
});

const closer = (id: string, busyAt: number[] = [], absent?: [number, number]): PlanCandidate => ({
  closerId: id as Id<"users">,
  name: id,
  busy: [
    ...busyAt.map((at) => ({ start: at, end: at + HOUR / 2, kind: "meeting" as const, opportunityId: "other" as Id<"opportunities"> })),
    ...(absent ? [{ start: absent[0], end: absent[1], kind: "absence" as const }] : []),
  ],
});

describe("planCoverage", () => {
  it("gives a deal's two meetings one owner who is free for both", () => {
    const result = planCoverage({ deals: [deal("d1", [AT(1), AT(5)])], candidates: [closer("a"), closer("b")], now: NOW });
    expect(result.assigned).toEqual([{ opportunityId: "d1", toCloserId: "a" }]);
    expect(result.unassigned).toEqual([]);
  });

  it("doesn't choose a closer busy for either meeting on the deal", () => {
    // "a" is free for the first call and has fewer calls, but is booked
    // during the second; a per-meeting choice would split the deal.
    const result = planCoverage({
      deals: [deal("d1", [AT(1), AT(5)])],
      candidates: [closer("a", [AT(5)]), closer("b", [AT(8), AT(9)])],
      now: NOW,
    });
    expect(result.assigned).toEqual([{ opportunityId: "d1", toCloserId: "b" }]);
    expect(result.candidates.find((c) => c.closerId === "a")?.freeFor).toEqual([]);
  });

  it("keeps the 15-minute buffer and respects absences", () => {
    const result = planCoverage({
      deals: [deal("d1", [AT(1)])],
      candidates: [closer("a", [AT(1) + 40 * 60_000]), closer("b", [], [AT(0), AT(2)])],
      now: NOW,
    });
    expect(result.assigned).toEqual([]);
    expect(result.unassigned).toEqual([{ opportunityId: "d1", reason: "No candidate is free for every call on this deal" }]);
  });

  it("never splits a deal: no one free for every call leaves it unassigned", () => {
    const result = planCoverage({
      deals: [deal("d1", [AT(1), AT(5)])],
      candidates: [closer("a", [AT(5)]), closer("b", [AT(1)])],
      now: NOW,
    });
    expect(result.assigned).toEqual([]);
    expect(result.unassigned.map((u) => u.opportunityId)).toEqual(["d1"]);
  });

  it("ignores past and finished meetings that move with the deal", () => {
    const d = deal("d1", [AT(1)]);
    d.meetings.push({ meetingId: "d1-old" as Id<"meetings">, opportunityId: d.opportunityId, scheduledAt: NOW - 48 * HOUR, durationMinutes: 30, status: "held" });
    const result = planCoverage({ deals: [d], candidates: [closer("a", [NOW - 48 * HOUR])], now: NOW });
    expect(result.assigned).toEqual([{ opportunityId: "d1", toCloserId: "a" }]);
  });

  it("serves the most constrained deal first and counts the plan's own calls", () => {
    // d2 at the same hour as d1 can go to either closer; d1 only to "b".
    const result = planCoverage({
      deals: [deal("d2", [AT(1)]), deal("d1", [AT(1), AT(5)])],
      candidates: [closer("a", [AT(5)]), closer("b")],
      now: NOW,
    });
    expect(Object.fromEntries(result.assigned.map((a) => [a.opportunityId, a.toCloserId]))).toEqual({ d1: "b", d2: "a" });
  });
});

describe("caps", () => {
  it("refuses more than 50 meetings, 25 deals or 8 candidates", () => {
    expect(capRefusal({ meetings: 50, deals: 25, candidates: 8 })).toBeNull();
    expect(capRefusal({ meetings: 51, deals: 1, candidates: 1 })).toMatch(/at most 50/);
    expect(capRefusal({ meetings: 26, deals: 26, candidates: 1 })).toMatch(/at most 25/);
    expect(capRefusal({ meetings: 1, deals: 1, candidates: 9 })).toMatch(/at most 8/);
    expect(COVERAGE_CAPS).toEqual({ meetings: 50, deals: 25, candidates: 8 });
  });
});

describe("assignmentConflicts", () => {
  it("finds a target now booked, and two deals the plan gives one target at once", () => {
    const deals = [deal("d1", [AT(1)]), deal("d2", [AT(1)])];
    expect(
      assignmentConflicts({
        deals,
        targets: [closer("a"), closer("b", [AT(1)])],
        assignments: [
          { opportunityId: "d1" as Id<"opportunities">, toCloserId: "a" as Id<"users"> },
          { opportunityId: "d2" as Id<"opportunities">, toCloserId: "b" as Id<"users"> },
        ],
        now: NOW,
      }).map((c) => c.opportunityId),
    ).toEqual(["d2"]);
    expect(
      assignmentConflicts({
        deals,
        targets: [closer("a")],
        assignments: [
          { opportunityId: "d1" as Id<"opportunities">, toCloserId: "a" as Id<"users"> },
          { opportunityId: "d2" as Id<"opportunities">, toCloserId: "a" as Id<"users"> },
        ],
        now: NOW,
      }),
    ).toHaveLength(2);
  });
});
