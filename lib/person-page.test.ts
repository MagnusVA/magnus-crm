import { describe, expect, it } from "vitest";
import {
  comparePersonDeals,
  dealProgramName,
  openDealState,
  paidByCurrency,
  stripNextStep,
  type OpenDealState,
  type Outcome,
  type PersonDeal,
} from "./person-page";

const NOW = Date.UTC(2026, 9, 31, 15, 0);
const HOUR = 3_600_000;

function deal(
  id: string,
  outcome: Outcome,
  state: OpenDealState | null,
  options: { createdAt?: number; canAct?: boolean } = {},
): PersonDeal<string> {
  return {
    item: id,
    outcome,
    state,
    createdAt: options.createdAt ?? 0,
    canAct: options.canAct ?? true,
  };
}

describe("openDealState", () => {
  it("takes an upcoming call before the open task", () => {
    const task = { kind: "task" as const, method: "call" as const, dueAt: NOW + 2 * HOUR };
    expect(openDealState({ callAt: NOW + HOUR, task, canSet: false }, null, NOW)).toEqual({
      kind: "step",
      step: { kind: "call", at: NOW + HOUR },
    });
  });

  it("owes the result of a call that ended still scheduled", () => {
    const meeting = { status: "scheduled" as const, scheduledAt: NOW - 2 * HOUR, durationMinutes: 45 };
    expect(openDealState({ callAt: NOW - 2 * HOUR, task: null, canSet: false }, meeting, NOW)).toEqual({
      kind: "not_recorded",
      callAt: NOW - 2 * HOUR,
    });
  });

  it("keeps a call under way as the step", () => {
    const meeting = { status: "scheduled" as const, scheduledAt: NOW - 10 * 60_000, durationMinutes: 45 };
    expect(
      openDealState({ callAt: NOW - 10 * 60_000, task: null, canSet: false }, meeting, NOW).kind,
    ).toBe("step");
  });

  it("has no step once the passed call is recorded and nothing else is set", () => {
    const meeting = { status: "held" as const, scheduledAt: NOW - 2 * HOUR, durationMinutes: 45 };
    expect(openDealState({ callAt: NOW - 2 * HOUR, task: null, canSet: true }, meeting, NOW)).toEqual({
      kind: "none",
    });
  });
});

describe("comparePersonDeals", () => {
  it("lists open deals with no step first, then by step time, then won, then lost, newest first", () => {
    const call = (at: number): OpenDealState => ({ kind: "step", step: { kind: "call", at } });
    const link: OpenDealState = { kind: "step", step: { kind: "link", reschedule: false, sentAt: NOW - HOUR } };
    const deals = [
      deal("lost-old", "lost", null, { createdAt: 1 }),
      deal("won", "won", null, { createdAt: 5 }),
      deal("link", "open", link),
      deal("call-later", "open", call(NOW + 5 * HOUR)),
      deal("lost-new", "lost", null, { createdAt: 9 }),
      deal("none", "open", { kind: "none" }),
      deal("call-soon", "open", call(NOW + HOUR)),
    ];
    expect(deals.sort(comparePersonDeals).map((entry) => entry.item)).toEqual([
      "none",
      "call-soon",
      "call-later",
      "link",
      "won",
      "lost-new",
      "lost-old",
    ]);
  });
});

describe("stripNextStep", () => {
  it("flags an unrecorded call on the viewer's deal before a deal with no step", () => {
    const deals = [
      deal("none", "open", { kind: "none" }),
      deal("missed", "open", { kind: "not_recorded", callAt: NOW - HOUR }),
    ];
    const result = stripNextStep(deals);
    expect(result.kind).toBe("not_recorded");
    expect(result.kind === "not_recorded" && result.others).toBe(1);
  });

  it("ignores another closer's deal with no step when the viewer's deals have one", () => {
    const deals = [
      deal("theirs", "open", { kind: "none" }, { canAct: false }),
      deal("mine", "open", { kind: "step", step: { kind: "call", at: NOW + HOUR } }),
    ];
    expect(stripNextStep(deals)).toMatchObject({ kind: "step", deal: { item: "mine" } });
  });

  it("reads no step without the amber when only another closer could act", () => {
    expect(stripNextStep([deal("theirs", "open", { kind: "none" }, { canAct: false })])).toMatchObject({
      kind: "none",
      owed: false,
    });
  });

  it("says there are no open deals when every deal is closed", () => {
    expect(stripNextStep([deal("won", "won", null)])).toEqual({ kind: "no_open" });
  });
});

describe("paidByCurrency", () => {
  it("keeps each currency apart and leads with the one with most payments", () => {
    expect(
      paidByCurrency([
        { currency: "usd", amountMinor: 900_00, status: "recorded" },
        { currency: "EUR", amountMinor: 100_00, status: "recorded" },
        { currency: "EUR", amountMinor: 50_00, status: "verified" },
        { currency: "EUR", amountMinor: 999_00, status: "disputed" },
      ]),
    ).toEqual([
      { currency: "EUR", amountMinor: 150_00, paymentCount: 2 },
      { currency: "USD", amountMinor: 900_00, paymentCount: 1 },
    ]);
  });
});

describe("dealProgramName", () => {
  it("names the sold program on a won deal and the booked one otherwise", () => {
    const programs = { soldProgramName: "Elite", firstBookingProgramName: "Starter" };
    expect(dealProgramName({ outcome: "won", ...programs })).toBe("Elite");
    expect(dealProgramName({ outcome: "open", ...programs })).toBe("Starter");
    expect(dealProgramName({ outcome: "lost" })).toBeNull();
  });
});
