import { describe, expect, it } from "vitest";
import {
  DEAL_OUTCOMES,
  DEAL_POSITION_LABELS,
  DEAL_POSITIONS,
  DEAL_STAGE_CONFIG,
  DEAL_STAGES,
  SYSTEM_LOSS_REASON_LABELS,
  SYSTEM_LOSS_REASONS,
  assertStageOutcome,
  dealPosition,
  dealStageOf,
  isAllowedStageOutcome,
  isSystemLossReason,
  missedMeetingLossReason,
  stageForStatus,
  stageOfPosition,
} from "./stages";
import { OPPORTUNITY_STATUSES } from "./stages";
import { SLACK_STALE_LOST_REASON } from "../pipeline/slackJoinLookup";

// The deal stage module (docs/plans/phase-5-deal-status.md §4.1, §4.2).

describe("the stage list", () => {
  it("has the five stages in order, and the three outcomes", () => {
    expect(DEAL_STAGES).toEqual(["qualified", "booked", "call_held", "follow_up", "closed"]);
    expect(DEAL_OUTCOMES).toEqual(["open", "won", "lost"]);
    expect(DEAL_STAGES.map((stage) => DEAL_STAGE_CONFIG[stage].label)).toEqual([
      "Qualified",
      "Booked",
      "Call held",
      "Follow-up",
      "Closed",
    ]);
  });

  it("allows open on the first four stages, and won or lost only on Closed", () => {
    const allowed = DEAL_STAGES.flatMap((stage) =>
      DEAL_OUTCOMES.filter((outcome) => isAllowedStageOutcome(stage, outcome)).map(
        (outcome) => `${stage}/${outcome}`,
      ),
    );
    expect(allowed).toEqual([
      "qualified/open",
      "booked/open",
      "call_held/open",
      "follow_up/open",
      "closed/won",
      "closed/lost",
    ]);
  });

  it.each([
    ["closed", "open"],
    ["booked", "won"],
    ["qualified", "lost"],
  ] as const)("refuses %s with outcome %s", (stage, outcome) => {
    expect(() => assertStageOutcome(stage, outcome)).toThrow(
      `Deal stage "${stage}" doesn't allow outcome "${outcome}"`,
    );
  });

  it("accepts every allowed pair", () => {
    expect(() => assertStageOutcome("follow_up", "open")).not.toThrow();
    expect(() => assertStageOutcome("closed", "lost")).not.toThrow();
  });
});

describe("positions", () => {
  it("shows six positions in order, with their labels", () => {
    expect(DEAL_POSITIONS).toEqual(["qualified", "booked", "call_held", "follow_up", "won", "lost"]);
    expect(DEAL_POSITIONS.map((position) => DEAL_POSITION_LABELS[position])).toEqual([
      "Qualified",
      "Booked",
      "Call held",
      "Follow-up",
      "Won",
      "Lost",
    ]);
  });

  it.each([
    ["qualified", "open", "qualified"],
    ["booked", "open", "booked"],
    ["call_held", "open", "call_held"],
    ["follow_up", "open", "follow_up"],
    ["closed", "won", "won"],
    ["closed", "lost", "lost"],
  ] as const)("places %s/%s at %s", (stage, outcome, position) => {
    expect(dealPosition(stage, outcome)).toBe(position);
  });

  it("refuses a pair the stage doesn't allow", () => {
    expect(() => dealPosition("closed", "open")).toThrow();
  });

  it("names each position's stage and outcome, the way back", () => {
    for (const position of DEAL_POSITIONS) {
      const { stage, outcome } = stageOfPosition(position);
      expect(dealPosition(stage, outcome)).toBe(position);
    }
    expect(stageOfPosition("lost")).toEqual({ stage: "closed", outcome: "lost" });
  });
});

describe("stageForStatus", () => {
  it.each([
    ["qualified_pending", "slack_qualified", "qualified", "open"],
    ["scheduled", "calendly", "booked", "open"],
    ["scheduled", "slack_qualified", "booked", "open"],
    ["scheduled", undefined, "booked", "open"],
    ["scheduled", "side_deal", "call_held", "open"],
    ["follow_up_scheduled", "calendly", "follow_up", "open"],
    ["follow_up_scheduled", "side_deal", "follow_up", "open"],
    ["reschedule_link_sent", "calendly", "follow_up", "open"],
    ["canceled", "calendly", "closed", "lost"],
    ["canceled", "slack_qualified", "closed", "lost"],
    ["no_show", "calendly", "closed", "lost"],
    ["payment_received", "calendly", "closed", "won"],
    ["payment_received", "side_deal", "closed", "won"],
    ["lost", "slack_qualified", "closed", "lost"],
    ["lost", "side_deal", "closed", "lost"],
  ] as const)("maps %s from %s to %s/%s", (status, source, stage, outcome) => {
    expect(stageForStatus(status, source)).toEqual({ stage, outcome });
  });

  it("maps every status to an allowed pair, from every source", () => {
    for (const status of OPPORTUNITY_STATUSES) {
      for (const source of ["calendly", "side_deal", "slack_qualified", undefined] as const) {
        const { stage, outcome } = stageForStatus(status, source);
        expect(isAllowedStageOutcome(stage, outcome)).toBe(true);
      }
    }
  });
});

describe("dealStageOf", () => {
  it("reads the stored stage and outcome", () => {
    expect(
      dealStageOf({ status: "scheduled", source: "calendly", stage: "follow_up", outcome: "open" }),
    ).toEqual({ stage: "follow_up", outcome: "open" });
  });

  it("maps the status of a deal the backfill hasn't reached", () => {
    expect(dealStageOf({ status: "scheduled", source: "side_deal" })).toEqual({
      stage: "call_held",
      outcome: "open",
    });
    expect(dealStageOf({ status: "no_show", source: undefined })).toEqual({
      stage: "closed",
      outcome: "lost",
    });
  });
});

describe("loss reasons the system writes", () => {
  it("has three codes with labels", () => {
    expect(SYSTEM_LOSS_REASONS).toEqual({ stale: "stale", no_show: "no_show", canceled: "canceled" });
    expect(SYSTEM_LOSS_REASON_LABELS).toEqual({
      stale: "Slack qualification expired",
      no_show: "No-show",
      canceled: "Canceled",
    });
  });

  it("tells a system code from what a person typed", () => {
    expect(["stale", "no_show", "canceled"].every(isSystemLossReason)).toBe(true);
    expect(isSystemLossReason("budget")).toBe(false);
    expect(isSystemLossReason("No-show")).toBe(false);
    expect(isSystemLossReason(undefined)).toBe(false);
  });

  it("is where the Slack expiry's reason comes from", () => {
    expect(SLACK_STALE_LOST_REASON).toBe(SYSTEM_LOSS_REASONS.stale);
  });

  it("names a missed meeting's reason from the status", () => {
    expect(missedMeetingLossReason("canceled")).toBe("canceled");
    expect(missedMeetingLossReason("no_show")).toBe("no_show");
    for (const status of OPPORTUNITY_STATUSES.filter(
      (status) => status !== "canceled" && status !== "no_show",
    )) {
      expect(missedMeetingLossReason(status)).toBeUndefined();
    }
  });
});
