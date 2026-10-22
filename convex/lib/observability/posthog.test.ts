import { describe, expect, it } from "vitest";
import { dealOutcomeProperties } from "./posthog";

// A new deal event sends its outcomes beside its stages
// (docs/plans/phase-5-deal-status.md §4.7).
describe("a domain event's deal outcomes in PostHog", () => {
  it("sends a new deal event's outcomes", () => {
    expect(dealOutcomeProperties({ fromOutcome: "open", toOutcome: "won" })).toEqual({
      from_outcome: "open",
      to_outcome: "won",
    });
    expect(dealOutcomeProperties({ toOutcome: "open" })).toEqual({ to_outcome: "open" });
  });

  it("sends none for an old event or a value that isn't an outcome", () => {
    expect(dealOutcomeProperties(undefined)).toEqual({});
    expect(dealOutcomeProperties({ programId: "p1" })).toEqual({});
    expect(dealOutcomeProperties({ fromOutcome: "scheduled", toOutcome: 1 })).toEqual({});
  });
});
