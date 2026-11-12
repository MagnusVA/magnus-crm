import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { initialSettings } from "../settings";
import { presentedNoShowTier } from "./state";

const HOUR = 3_600_000;
const meeting = { scheduledAt: 0, durationMinutes: 30 };
const tenant = (wait: number | undefined) => ({
  callInsights: {
    ...initialSettings("user" as Id<"users">, 0),
    noShowCertain: true,
    noShowWaitMinutes: wait,
  },
});
// The closer waited seven minutes; the slot ended hours ago.
const row = { noShowTier: "certain" as const, waitedSeconds: 7 * 60 };
const now = 5 * HOUR;

describe("presentedNoShowTier", () => {
  it("keeps a Certain while the closer's wait meets the wait required today", () => {
    expect(presentedNoShowTier(row, meeting, tenant(5), now)).toBe("certain");
  });

  it("reads as Review once the required wait is raised past it or cleared", () => {
    expect(presentedNoShowTier(row, meeting, tenant(10), now)).toBe("review");
    expect(presentedNoShowTier(row, meeting, tenant(undefined), now)).toBe(
      "review",
    );
  });

  it("reads as Review within an hour of the slot ending, and when the wait was never stored", () => {
    expect(presentedNoShowTier(row, meeting, tenant(5), HOUR)).toBe("review");
    expect(
      presentedNoShowTier({ noShowTier: "certain" }, meeting, tenant(5), now),
    ).toBe("review");
  });
});
