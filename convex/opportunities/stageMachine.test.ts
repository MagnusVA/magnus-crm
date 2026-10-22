import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { legacyStatus } from "./dealState";
import {
  DEAL_POSITIONS,
  STAGE_TRANSITION_EXCEPTIONS,
  VALID_STAGE_TRANSITIONS,
  assertStageMove,
  exceptionAllows,
  stageForStatus,
  stageMoveAllowed,
  stageOfPosition,
  type DealPosition,
  type DealTarget,
  type StageMachineDeal,
  type StageTransitionException,
} from "./stages";
import { pr7Moves } from "../../tests/stageMachineFixtures";

// The stage machine (docs/plans/phase-5-deal-status.md §4.4).

const PERSON = "user_person" as Id<"users">;

function targetOf(position: DealPosition): DealTarget {
  const { stage, outcome } = stageOfPosition(position);
  return stage === "closed"
    ? { stage, outcome: outcome as "won" | "lost" }
    : { stage };
}

function dealAt(position: DealPosition, loss: Partial<StageMachineDeal> = {}): StageMachineDeal {
  return { ...stageOfPosition(position), source: "calendly", ...loss };
}

const EXCEPTIONS = Object.keys(STAGE_TRANSITION_EXCEPTIONS) as StageTransitionException[];

describe("the stage machine", () => {
  it("allows exactly the moves in the plan's table", () => {
    expect(VALID_STAGE_TRANSITIONS).toEqual({
      qualified: ["booked", "lost"],
      booked: ["follow_up", "won", "lost"],
      call_held: ["follow_up", "won", "lost"],
      follow_up: ["booked", "won", "lost"],
      won: [],
      lost: [],
    });
  });

  it("allows every move in the table and refuses every other, without an exception", () => {
    for (const from of DEAL_POSITIONS)
      for (const to of DEAL_POSITIONS)
        expect({ from, to, allowed: stageMoveAllowed(dealAt(from), targetOf(to)) }).toEqual({
          from,
          to,
          allowed: VALID_STAGE_TRANSITIONS[from].includes(to),
        });
  });

  it("never allows a move to where the deal is", () => {
    for (const position of DEAL_POSITIONS)
      for (const exception of [undefined, ...EXCEPTIONS])
        expect(stageMoveAllowed(dealAt(position), targetOf(position), exception)).toBe(false);
  });

  it("names both ends when it refuses", () => {
    expect(() => assertStageMove(dealAt("won"), { stage: "booked" })).toThrow(
      'Cannot move deal from "closed won" to "booked"',
    );
    expect(() =>
      assertStageMove(dealAt("lost", { lostReason: "budget", lostByUserId: PERSON }), { stage: "booked" }, "slack_stale_rejoin"),
    ).toThrow('Cannot move deal from "closed lost" to "booked" with "slack_stale_rejoin"');
  });

  it("refuses any move from a pair the stage doesn't allow", () => {
    const broken: StageMachineDeal = { stage: "closed", outcome: "open", source: "calendly" };
    for (const to of DEAL_POSITIONS) expect(stageMoveAllowed(broken, targetOf(to))).toBe(false);
  });

  it("reads the stage of a deal without one from its status", () => {
    const deal: StageMachineDeal = { status: "follow_up_scheduled", source: "calendly" };
    expect(stageMoveAllowed(deal, { stage: "booked" })).toBe(true);
    expect(stageMoveAllowed(deal, { stage: "follow_up" })).toBe(false);
  });
});

describe("the named exceptions", () => {
  const SYSTEM = (lostReason: string): Partial<StageMachineDeal> => ({ lostReason });
  const BY_PERSON = (lostReason?: string): Partial<StageMachineDeal> => ({ lostReason, lostByUserId: PERSON });

  // Each exception's move, and the losses it reopens and refuses.
  const CASES: Array<{
    exception: StageTransitionException;
    from: DealPosition;
    to: DealPosition;
    allows: Partial<StageMachineDeal>[];
    refuses: Partial<StageMachineDeal>[];
  }> = [
    {
      exception: "payment_voided",
      from: "won",
      to: "lost",
      allows: [{}],
      refuses: [],
    },
    {
      exception: "slack_stale_rejoin",
      from: "lost",
      to: "booked",
      allows: [SYSTEM("stale")],
      // A person's free-text "stale" no longer reopens the deal (plan §2.4:
      // production has none).
      refuses: [BY_PERSON("stale"), SYSTEM("no_show"), SYSTEM("canceled"), BY_PERSON("budget"), {}],
    },
    {
      exception: "missed_meeting_next_step",
      from: "lost",
      to: "follow_up",
      allows: [SYSTEM("no_show"), SYSTEM("canceled")],
      refuses: [BY_PERSON("no_show"), BY_PERSON("canceled"), SYSTEM("stale"), BY_PERSON("budget"), BY_PERSON(), {}],
    },
    {
      exception: "no_show_withdrawn",
      from: "lost",
      to: "booked",
      allows: [SYSTEM("no_show")],
      refuses: [SYSTEM("canceled"), BY_PERSON("no_show"), SYSTEM("stale"), BY_PERSON("budget"), {}],
    },
  ];

  it("has the four in the plan, and no Calendly flip", () => {
    expect(EXCEPTIONS.sort()).toEqual(
      ["missed_meeting_next_step", "no_show_withdrawn", "payment_voided", "slack_stale_rejoin"].sort(),
    );
  });

  it.each(CASES)("$exception moves $from to $to only from the loss it was written for", (testCase) => {
    const { exception, from, to } = testCase;
    for (const loss of testCase.allows) {
      expect({ loss, allowed: stageMoveAllowed(dealAt(from, loss), targetOf(to), exception) }).toEqual({
        loss,
        allowed: true,
      });
      expect(stageMoveAllowed(dealAt(from, loss), targetOf(to))).toBe(false);
    }
    for (const loss of testCase.refuses)
      expect({ loss, allowed: stageMoveAllowed(dealAt(from, loss), targetOf(to), exception) }).toEqual({
        loss,
        allowed: false,
      });
  });

  it.each(CASES)("$exception allows no other move", ({ exception, from, to, allows }) => {
    for (const fromPosition of DEAL_POSITIONS)
      for (const toPosition of DEAL_POSITIONS) {
        if (fromPosition === from && toPosition === to) continue;
        if (VALID_STAGE_TRANSITIONS[fromPosition].includes(toPosition)) continue;
        for (const loss of allows)
          expect(exceptionAllows(exception, dealAt(fromPosition, loss), toPosition)).toBe(false);
      }
  });
});

describe("every move PR 7 made is a stage move", () => {
  // The stage target and the exception each PR 7 move becomes (§5). The
  // Calendly flip between no-show and canceled is no move: the reason
  // changes on the closed deal.
  const EXCEPTION_FOR: Record<string, StageTransitionException | undefined> = {
    "lost->scheduled": "slack_stale_rejoin",
    "payment_received->lost": "payment_voided",
    "no_show->follow_up_scheduled": "missed_meeting_next_step",
    "no_show->reschedule_link_sent": "missed_meeting_next_step",
    "canceled->follow_up_scheduled": "missed_meeting_next_step",
    "no_show->scheduled": "no_show_withdrawn",
  };
  const LOSS_OF: Partial<Record<string, Partial<StageMachineDeal>>> = {
    no_show: { lostReason: "no_show" },
    canceled: { lostReason: "canceled" },
    lost: { lostReason: "stale" },
  };

  it.each(pr7Moves().filter(([, , exception]) => exception !== "calendly_webhook"))(
    "%s -> %s (%s)",
    (from, to) => {
      // canceled -> scheduled was the 14-day join PR 2 removed; no caller makes it.
      if (from === "canceled" && to === "scheduled") return;
      const source = from === "lost" ? "slack_qualified" : "calendly";
      const deal: StageMachineDeal = { status: from, source, ...stageForStatus(from, source), ...LOSS_OF[from] };
      const { stage, outcome } = stageForStatus(to, source);
      const target: DealTarget =
        stage === "closed" ? { stage, outcome: outcome as "won" | "lost" } : { stage };
      const exception = EXCEPTION_FOR[`${from}->${to}`];
      expect(stageMoveAllowed(deal, target, exception)).toBe(true);
      // The status PR 8 writes after the move is the one PR 7 wrote.
      const next = {
        ...deal,
        stage,
        outcome,
        ...(outcome === "open" ? { lostReason: undefined } : {}),
        ...(to === "no_show" || to === "canceled" ? { lostReason: to } : {}),
      };
      expect(legacyStatus(next, { hasPendingRescheduleLink: to === "reschedule_link_sent" })).toBe(to);
    },
  );
});
