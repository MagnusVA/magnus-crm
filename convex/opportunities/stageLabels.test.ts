import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { OPPORTUNITY_STATUSES, type OpportunityStatus } from "../lib/statusTransitions";
import {
  LEGACY_STATUS_LABELS,
  dealEventOutcomes,
  dealEventStateLabel,
  dealLabelOf,
  dealPositionLabel,
  dealSearchWords,
  meetingDealLabelOf,
  parseDealEventOutcomes,
  systemLossOf,
} from "./stageLabels";
import { missedMeetingLossReason, stageForStatus, type DealSource } from "./stages";

// The deal's labels read from its stage and outcome, and the labels of old
// and new deal events (docs/plans/phase-5-deal-status.md §4.1, §4.7, §6.1).

const PERSON = "user_person" as Id<"users">;

/** A deal at `status` as the dual write leaves it: the mapped stage and a missed meeting's loss. */
function deal(status: OpportunityStatus, source: DealSource = "calendly", fields = {}) {
  const reason = missedMeetingLossReason(status);
  return {
    status,
    source,
    ...stageForStatus(status, source),
    ...(reason ? { lostReason: reason } : {}),
    ...fields,
  };
}

describe("a deal's label", () => {
  it.each([
    ["qualified_pending", "slack", "qualified", "open", "qualified", "Qualified"],
    ["scheduled", "calendly", "booked", "open", "booked", "Booked"],
    ["scheduled", "side_deal", "call_held", "open", "call_held", "Call held"],
    ["follow_up_scheduled", "calendly", "follow_up", "open", "follow_up", "Follow-up"],
    ["reschedule_link_sent", "calendly", "follow_up", "open", "follow_up", "Follow-up"],
    ["payment_received", "calendly", "closed", "won", "won", "Won"],
    ["lost", "calendly", "closed", "lost", "lost", "Lost"],
    ["canceled", "calendly", "closed", "lost", "lost", "Lost: canceled"],
    ["no_show", "calendly", "closed", "lost", "lost", "Lost: no-show"],
  ] as const)("reads %s (%s) as %s/%s, shown as %s", (status, source, stage, outcome, position, label) => {
    const fields = dealLabelOf(deal(status, source));
    expect(fields).toMatchObject({ stage, outcome, position });
    expect(dealPositionLabel(fields.position, fields.systemLoss)).toBe(label);
  });

  it("reads a deal from before the backfill by its status", () => {
    expect(dealLabelOf({ status: "scheduled", source: "side_deal" })).toEqual({
      stage: "call_held",
      outcome: "open",
      position: "call_held",
      systemLoss: null,
    });
  });

  it("shows the Slack expiry as a system loss", () => {
    const expired = deal("lost", "slack", { lostReason: "stale" });
    expect(systemLossOf(expired)).toBe("stale");
    expect(dealPositionLabel("lost", systemLossOf(expired))).toBe("Lost: expired");
  });

  it("shows a person's loss as Lost, whatever its text", () => {
    for (const lostReason of ["no_show", "canceled", "stale", "Price"]) {
      const byPerson = deal("lost", "calendly", { lostReason, lostByUserId: PERSON });
      expect(systemLossOf(byPerson)).toBeNull();
      expect(dealPositionLabel("lost", systemLossOf(byPerson))).toBe("Lost");
    }
    expect(systemLossOf(deal("lost"))).toBeNull();
  });

  it("names no system loss on a deal that isn't lost", () => {
    // A reopened deal whose reason wasn't cleared still reads its stage.
    expect(systemLossOf(deal("follow_up_scheduled", "calendly", { lostReason: "no_show" }))).toBeNull();
    expect(dealPositionLabel("won", "no_show")).toBe("Won");
  });

  it("gives a meeting its deal's label under the deal's names", () => {
    expect(meetingDealLabelOf(deal("no_show"))).toEqual({
      dealStage: "closed",
      dealOutcome: "lost",
      dealPosition: "lost",
      dealSystemLoss: "no_show",
    });
  });
});

describe("a deal's search words", () => {
  it.each([
    ["qualified_pending", "slack", ["Qualified"]],
    ["scheduled", "calendly", ["Booked"]],
    ["scheduled", "side_deal", ["Call held"]],
    ["reschedule_link_sent", "calendly", ["Follow-up"]],
    ["payment_received", "calendly", ["Won"]],
    ["lost", "slack", ["Lost"]],
    ["no_show", "calendly", ["Lost", "no show"]],
    ["canceled", "calendly", ["Lost", "canceled"]],
  ] as const)("searches %s (%s) by %j", (status, source, words) => {
    expect(dealSearchWords(deal(status, source))).toEqual(words);
  });

  it("doesn't search a person's loss by a missed meeting's words", () => {
    expect(dealSearchWords(deal("lost", "calendly", { lostReason: "no_show", lostByUserId: PERSON }))).toEqual([
      "Lost",
    ]);
  });
});

describe("a deal event's labels", () => {
  it("labels every old status", () => {
    expect(Object.keys(LEGACY_STATUS_LABELS).sort()).toEqual([...OPPORTUNITY_STATUSES].sort());
    expect(dealEventStateLabel("scheduled")).toBe("Scheduled");
    expect(dealEventStateLabel("payment_received")).toBe("Payment received");
    expect(dealEventStateLabel("qualified_pending")).toBe("Qualified, not booked");
    expect(dealEventStateLabel("no_show")).toBe("No-show");
  });

  it("labels a new event's stages with the outcome of a Closed one", () => {
    expect(dealEventStateLabel("booked", "open")).toBe("Booked");
    expect(dealEventStateLabel("call_held", "open")).toBe("Call held");
    expect(dealEventStateLabel("closed", "won")).toBe("Closed (won)");
    expect(dealEventStateLabel("closed", "lost")).toBe("Closed (lost)");
    expect(dealEventStateLabel("closed")).toBe("Closed");
  });

  it("keeps an unknown value and drops an empty one", () => {
    expect(dealEventStateLabel("something_else")).toBe("something_else");
    expect(dealEventStateLabel(undefined)).toBeNull();
    expect(dealEventStateLabel("")).toBeNull();
  });

  it("reads the outcomes a new event records in its metadata", () => {
    expect(dealEventOutcomes({ fromOutcome: "open", toOutcome: "won" })).toEqual({
      fromOutcome: "open",
      toOutcome: "won",
    });
    expect(dealEventOutcomes({ fromOutcome: "maybe", toOutcome: 3 })).toEqual({
      fromOutcome: null,
      toOutcome: null,
    });
    expect(dealEventOutcomes(null)).toEqual({ fromOutcome: null, toOutcome: null });
    expect(parseDealEventOutcomes(JSON.stringify({ toOutcome: "lost" }))).toEqual({
      fromOutcome: null,
      toOutcome: "lost",
    });
    expect(parseDealEventOutcomes("not json")).toEqual({ fromOutcome: null, toOutcome: null });
    expect(parseDealEventOutcomes(undefined)).toEqual({ fromOutcome: null, toOutcome: null });
  });
});
