import { describe, expect, it } from "vitest";
import type { OpportunityStatus } from "../opportunities/stages";
import { at, readDealHistory, type HistoryChange } from "../../tests/bookingRuleFixtures";

// A late booking's guard rebuilds where a deal was when the booking happened
// from the changes it recorded since, old events (statuses) and new ones
// (stages, from PR 8), and gives no answer when the chain has a gap
// (docs/plans/phase-5-deal-status.md §4.7).

const T = Date.parse("2026-10-14T09:13:23Z");

/** The deal's position at T, and whether a booking at T couldn't have joined it. */
async function positionAt(
  current: OpportunityStatus,
  changes: HistoryChange[],
  createdAt = T - 60_000,
  otherEvents = 0,
  options: { rescheduleLink?: boolean; dropOutcomes?: boolean; source?: "side_deal" } = {},
) {
  return await readDealHistory(current, changes, { time: T, createdAt, otherEvents, ...options });
}

describe("old events, which record statuses", () => {
  it("reads a deal's position at a time from the changes it recorded after", async () => {
    expect(await positionAt("canceled", [
      [T - 60_000, undefined, "scheduled"],
      [T + 21_000, "scheduled", "canceled"],
    ])).toEqual({ position: "booked", unattachable: true });
    expect(await positionAt("scheduled", [
      [T + 1_000, "canceled", "scheduled"],
    ])).toEqual({ position: "lost", unattachable: false });
    // No status change since: the deal had its current position.
    expect(await positionAt("scheduled", [])).toEqual({ position: "booked", unattachable: true });
  });

  it("doesn't answer when the recorded changes don't account for the current status", async () => {
    // A gap: two changes that don't chain.
    expect(await positionAt("canceled", [
      [T + 1_000, "scheduled", "no_show"],
      [T + 2_000, "follow_up_scheduled", "canceled"],
    ])).toEqual({ position: undefined, unattachable: false });
    // The last change doesn't end at the current status.
    expect(await positionAt("canceled", [
      [T + 1_000, "scheduled", "no_show"],
    ])).toEqual({ position: undefined, unattachable: false });
  });

  it("treats a deal created after the time as within reach", async () => {
    expect(await positionAt("scheduled", [], T + 1_000)).toEqual({ position: "booked", unattachable: false });
  });

  it("doesn't count events that aren't status changes against the cap", async () => {
    const flips = Array.from({ length: 32 }, (_, i): HistoryChange =>
      i % 2 === 0 ? [T + 100 + i, "scheduled", "canceled"] : [T + 100 + i, "canceled", "scheduled"]);
    expect(await positionAt("scheduled", flips, T - 60_000, 1)).toEqual({ position: "booked", unattachable: true });
    // More status changes than it reads: no answer.
    expect(await positionAt("canceled", [...flips, [T + 200, "scheduled", "canceled"]]))
      .toEqual({ position: undefined, unattachable: false });
  });

  it("checks the last change against everything the deal's fields say of its status", async () => {
    // Between two old events the raw statuses must chain, so a no-show isn't a cancellation.
    expect(await positionAt("canceled", [
      [T + 1_000, "scheduled", "no_show"],
      [T + 2_000, "canceled", "scheduled"],
      [T + 3_000, "scheduled", "canceled"],
    ])).toEqual({ position: undefined, unattachable: false });
    // A reschedule link on Follow-up is `reschedule_link_sent`, and without one it isn't.
    expect(await positionAt("reschedule_link_sent", [
      [T + 1_000, "no_show", "reschedule_link_sent"],
    ], T - 60_000, 0, { rescheduleLink: true })).toEqual({ position: "lost", unattachable: false });
    expect(await positionAt("follow_up_scheduled", [
      [T + 1_000, "no_show", "reschedule_link_sent"],
    ])).toEqual({ position: undefined, unattachable: false });
    expect(await positionAt("follow_up_scheduled", [
      [T + 1_000, "scheduled", "follow_up_scheduled"],
    ])).toEqual({ position: "booked", unattachable: true });
    // A side deal at `scheduled` is Call held, out of reach as today.
    expect(await positionAt("payment_received", [
      [T + 1_000, "scheduled", "payment_received"],
    ], T - 60_000, 0, { source: "side_deal" })).toEqual({ position: "call_held", unattachable: true });
  });
});

describe("new events, which record stages with the outcomes in their metadata", () => {
  it("reads a deal's position from them", async () => {
    expect(await positionAt("canceled", [
      [T + 21_000, at("booked"), at("closed", "lost")],
    ])).toEqual({ position: "booked", unattachable: true });
    expect(await positionAt("payment_received", [
      [T + 1_000, at("follow_up"), at("booked")],
      [T + 2_000, at("booked"), at("closed", "won")],
    ])).toEqual({ position: "follow_up", unattachable: false });
    expect(await positionAt("follow_up_scheduled", [
      [T + 1_000, at("closed", "won"), at("closed", "lost")],
      [T + 2_000, at("closed", "lost"), at("follow_up")],
    ])).toEqual({ position: "won", unattachable: true });
    // A reschedule link doesn't change a Follow-up stage.
    expect(await positionAt("reschedule_link_sent", [
      [T + 1_000, at("closed", "lost"), at("follow_up")],
    ], T - 60_000, 0, { rescheduleLink: true })).toEqual({ position: "lost", unattachable: false });
  });

  it("doesn't answer when they don't chain or don't end at the deal's stage and outcome", async () => {
    expect(await positionAt("canceled", [
      [T + 1_000, at("booked"), at("follow_up")],
      [T + 2_000, at("booked"), at("closed", "lost")],
    ])).toEqual({ position: undefined, unattachable: false });
    // Closed won isn't Closed lost.
    expect(await positionAt("canceled", [
      [T + 1_000, at("closed", "won"), at("closed", "lost")],
      [T + 2_000, at("closed", "won"), at("closed", "lost")],
    ])).toEqual({ position: undefined, unattachable: false });
    expect(await positionAt("canceled", [
      [T + 1_000, at("booked"), at("closed", "won")],
    ])).toEqual({ position: undefined, unattachable: false });
  });

  it("doesn't answer for a Closed event that records no outcome", async () => {
    expect(await positionAt("canceled", [
      [T + 1_000, at("booked"), at("closed", "lost")],
    ], T - 60_000, 0, { dropOutcomes: true })).toEqual({ position: undefined, unattachable: false });
    // An open stage allows one outcome, so its event needs none.
    expect(await positionAt("scheduled", [
      [T + 1_000, at("follow_up"), at("booked")],
    ], T - 60_000, 0, { dropOutcomes: true })).toEqual({ position: "follow_up", unattachable: false });
  });
});

describe("a history across the change from old events to new ones", () => {
  it("maps the old status through the stage where the two meet", async () => {
    expect(await positionAt("follow_up_scheduled", [
      [T + 1_000, "scheduled", "no_show"],
      [T + 2_000, at("closed", "lost"), at("follow_up")],
    ])).toEqual({ position: "booked", unattachable: true });
    expect(await positionAt("scheduled", [
      [T + 1_000, "follow_up_scheduled", "scheduled"],
      [T + 2_000, at("booked"), at("closed", "lost")],
      [T + 3_000, at("closed", "lost"), at("booked")],
    ])).toEqual({ position: "follow_up", unattachable: false });
    // A revert to the old events after new ones (§12) reads the same way.
    expect(await positionAt("payment_received", [
      [T + 1_000, at("follow_up"), at("booked")],
      [T + 2_000, "scheduled", "payment_received"],
    ])).toEqual({ position: "follow_up", unattachable: false });
  });

  it("doesn't answer for a gap where the two meet", async () => {
    expect(await positionAt("follow_up_scheduled", [
      [T + 1_000, "scheduled", "payment_received"],
      [T + 2_000, at("closed", "lost"), at("follow_up")],
    ])).toEqual({ position: undefined, unattachable: false });
    expect(await positionAt("canceled", [
      [T + 1_000, "follow_up_scheduled", "scheduled"],
      [T + 2_000, at("follow_up"), at("closed", "lost")],
    ])).toEqual({ position: undefined, unattachable: false });
    expect(await positionAt("payment_received", [
      [T + 1_000, at("booked"), at("closed", "lost")],
      [T + 2_000, "scheduled", "payment_received"],
    ])).toEqual({ position: undefined, unattachable: false });
  });
});
