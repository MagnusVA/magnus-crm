import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { countStripByStatus, readCloserMeetingDeals } from "./dashboard";
import {
  MEETING_RANGE,
  seededCloserPipeline,
} from "../../tests/closerPipelineFixtures";

// The closer's pipeline tabs and dashboard strip count by position
// (docs/plans/phase-5-deal-status.md §6.2).

const noPositions = { qualified: 0, booked: 0, call_held: 0, follow_up: 0, won: 0, lost: 0 };

describe("getPipelineSummary", () => {
  it("counts the closer's deals at each position for the tabs, All the sum", async () => {
    const { harness } = await seededCloserPipeline();

    const summary = await harness.closer.query(api.closer.dashboard.getPipelineSummary, {});

    // Lost holds the person's loss and both missed meetings' losses; the
    // other closer's loss isn't counted.
    expect(summary).toEqual({
      counts: { ...noPositions, booked: 1, call_held: 1, follow_up: 3, won: 1, lost: 3 },
      total: 9,
      decided: null,
      cashCollectedMinor: null,
      cashPaymentCount: null,
      isPaymentDataTruncated: false,
    });
  });

  it("counts the deals behind the period's meetings by position for the strip", async () => {
    const { harness } = await seededCloserPipeline();

    const strip = await harness.closer.query(api.closer.dashboard.getPipelineSummary, MEETING_RANGE);

    // The reminder deal's meeting is before the week; the booked deal's two
    // meetings count it once.
    expect(strip.counts).toEqual({ ...noPositions, booked: 1, follow_up: 1, won: 1, lost: 3 });
    expect(strip.total).toBe(6);
    expect([strip.cashCollectedMinor, strip.cashPaymentCount]).toEqual([0, 0]);
  });

  it("leaves the system's losses out of the close rate, which matches the status way", async () => {
    const { harness } = await seededCloserPipeline();

    const strip = await harness.closer.query(api.closer.dashboard.getPipelineSummary, MEETING_RANGE);
    const byStatus = await harness.t.run(async (ctx) =>
      countStripByStatus(
        await readCloserMeetingDeals(
          ctx,
          harness.tenantId,
          harness.closerId,
          MEETING_RANGE.startDate,
          MEETING_RANGE.endDate,
        ),
      ),
    );

    // Won 1 of 2 decided: the no-show's and the cancellation's losses are
    // Lost on the strip but not decided.
    expect(strip.decided).toEqual({ won: 1, lost: 1 });
    expect(strip.decided).toEqual({
      won: byStatus.counts.payment_received,
      lost: byStatus.counts.lost,
    });
  });

  it("refuses a range that ends before it starts", async () => {
    const { harness } = await seededCloserPipeline();
    await expect(
      harness.closer.query(api.closer.dashboard.getPipelineSummary, {
        startDate: MEETING_RANGE.endDate,
        endDate: MEETING_RANGE.startDate,
      }),
    ).rejects.toThrow("startDate must be earlier than endDate");
  });
});
