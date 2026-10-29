import { describe, expect, it, vi } from "vitest";
import { getConvexSize } from "convex/values";
import { api } from "../_generated/api";
import { readCloserMeetingDeals } from "./dashboard";
import { closerBoundedReadFixture } from "../../tests/closerBoundedReadFixtures";
import {
  closerPipelineHarness,
  DAY,
  HOUR,
  insertCloserDeal,
  insertCloserMeeting,
  MEETING_RANGE,
  seededCloserPipeline,
  T0,
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
    expect(strip).toMatchObject({ isMeetingDataTruncated: false });
    expect([strip.cashCollectedMinor, strip.cashPaymentCount]).toEqual([0, 0]);
  });

  it("counts the period's held and no-show calls for the show-up rate", async () => {
    const { harness } = await seededCloserPipeline();

    const strip = await harness.closer.query(api.closer.dashboard.getPipelineSummary, MEETING_RANGE);

    // Held: the win and the person's loss. No-show: the reschedule-link deal's
    // and the no-show deal's. Canceled and still-scheduled calls count in
    // neither, and the other closer's held call isn't the closer's.
    expect(strip).toMatchObject({ heldCount: 2, noShowCount: 2 });
  });

  it("leaves attendance out of the all-time tabs", async () => {
    const { harness } = await seededCloserPipeline();
    const summary = await harness.closer.query(api.closer.dashboard.getPipelineSummary, {});
    expect(summary).not.toHaveProperty("heldCount");
    expect(summary).not.toHaveProperty("noShowCount");
  });

  it("leaves the system's losses out of the close rate", async () => {
    const { harness } = await seededCloserPipeline();

    const strip = await harness.closer.query(api.closer.dashboard.getPipelineSummary, MEETING_RANGE);

    // Won 1 of 2 decided: the no-show's and the cancellation's losses are
    // Lost on the strip but not decided.
    expect(strip.decided).toEqual({ won: 1, lost: 1 });
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

describe("bounded closer meeting deals", () => {
  it("caps meetings before deduplicating deals and reads each retained deal once", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    await harness.t.run(async (ctx) => {
      const get = vi.spyOn(ctx.db, "get");
      const read = await readCloserMeetingDeals(ctx, harness.tenantId, harness.closerId, T0, T0 + 10, 2);
      expect(read.deals.map((deal) => deal._id)).toEqual([seed.ownDeal]);
      expect(read.isMeetingDataTruncated).toBe(true);
      expect(get.mock.calls).toEqual([["opportunities", seed.ownDeal]]);
    });
  });

  it("reports complete at the exact cap and still drops reassigned deals", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    const read = await harness.t.run((ctx) =>
      readCloserMeetingDeals(ctx, harness.tenantId, harness.closerId, T0, T0 + 10, 3),
    );
    expect(read.deals.map((deal) => deal._id)).toEqual([seed.ownDeal]);
    expect(read.isMeetingDataTruncated).toBe(false);
  });

  it("stops at the byte budget even below the row cap", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    await harness.t.run(async (ctx) => {
      const first = (await ctx.db.get("meetings", seed.meetings[0]))!;
      const read = await readCloserMeetingDeals(ctx, harness.tenantId, harness.closerId, T0, T0 + 10, 10, getConvexSize(first));
      expect(read.deals.map((deal) => deal._id)).toEqual([seed.ownDeal]);
      expect(read.isMeetingDataTruncated).toBe(true);
    });
  });

  it("drops missing and other-tenant deals", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    await harness.t.run(async (ctx) => {
      await ctx.db.delete("opportunities", seed.ownDeal);
      const otherTenantId = await ctx.db.insert("tenants", {
        companyName: "Other", contactEmail: "other@example.com", workosOrgId: "org_other",
        status: "active", inviteExpiresAt: 0, createdBy: "test",
      });
      await ctx.db.patch("opportunities", seed.reassignedDeal, { tenantId: otherTenantId, assignedCloserId: harness.closerId });
      const read = await readCloserMeetingDeals(ctx, harness.tenantId, harness.closerId, T0, T0 + 10);
      expect(read).toEqual({
        deals: [],
        attendance: { held: 0, noShow: 0 },
        isMeetingDataTruncated: false,
      });
    });
  });
});

describe("getNextMeeting", () => {
  it("skips reassigned deals and non-scheduled meetings, preserving enrichment", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    const now = Date.now();
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("meetings", seed.meetings[0], { scheduledAt: now + DAY });
      await ctx.db.patch("meetings", seed.meetings[2], { scheduledAt: now + DAY + 1000 });
      await ctx.db.patch("meetings", seed.meetings[1], { scheduledAt: now + DAY + 2000 });
    });
    const result = await harness.closer.query(api.closer.dashboard.getNextMeeting, {});
    expect(result).toMatchObject({
      meeting: { _id: seed.meetings[1] }, opportunity: { _id: seed.ownDeal },
      lead: { email: "deal-person@example.com" }, eventTypeName: "Bounded call",
    });
  });

  it("returns incomplete after 25 ineligible candidates even when a later one qualifies", async () => {
    const harness = await closerPipelineHarness();
    await harness.t.run(async (ctx) => {
      const now = Date.now();
      const reassigned = await insertCloserDeal(ctx, {
        tenantId: harness.tenantId, closerId: harness.otherCloserId, status: "scheduled", createdAt: now,
      });
      const owned = await insertCloserDeal(ctx, {
        tenantId: harness.tenantId, closerId: harness.closerId, status: "scheduled", createdAt: now,
      });
      for (let i = 0; i < 26; i++) {
        await insertCloserMeeting(ctx, {
          tenantId: harness.tenantId, closerId: harness.closerId,
          opportunityId: i < 25 ? reassigned : owned,
          scheduledAt: now + 60_000 + i * 1000, status: "scheduled",
        });
      }
    });
    await expect(harness.closer.query(api.closer.dashboard.getNextMeeting, {})).resolves.toEqual({ meeting: null, incomplete: true });
  });

  it("returns null when the scheduled candidates are exhausted below 25", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    await harness.t.run(async (ctx) => {
      // The closer's call ended a minute ago; the later one is a reassigned deal's.
      await ctx.db.patch("meetings", seed.meetings[1], { scheduledAt: Date.now() - 31 * 60_000 });
      await ctx.db.patch("meetings", seed.meetings[2], { scheduledAt: Date.now() + 60_000 });
    });
    await expect(harness.closer.query(api.closer.dashboard.getNextMeeting, {})).resolves.toBeNull();
  });

  it("keeps a call in progress as the next meeting until it ends", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    await harness.t.run(async (ctx) => {
      // Started ten minutes ago, thirty minutes long; another call later today.
      await ctx.db.patch("meetings", seed.meetings[1], { scheduledAt: Date.now() - 10 * 60_000 });
      await insertCloserMeeting(ctx, {
        tenantId: harness.tenantId, closerId: harness.closerId, opportunityId: seed.ownDeal,
        scheduledAt: Date.now() + 2 * HOUR, status: "scheduled",
      });
    });
    const result = await harness.closer.query(api.closer.dashboard.getNextMeeting, {});
    expect(result).toMatchObject({ meeting: { _id: seed.meetings[1] } });
  });
});

describe("getMeetingsNeedingOutcome", () => {
  it("lists the closer's ended calls with no result, newest first, on deals still awaiting one", async () => {
    const harness = await closerPipelineHarness();
    const now = Date.now();
    const ids = await harness.t.run(async (ctx) => {
      const deal = (closerId = harness.closerId, status: "scheduled" | "follow_up_scheduled" = "scheduled") =>
        insertCloserDeal(ctx, { tenantId: harness.tenantId, closerId, status, createdAt: now - DAY });
      const meeting = (
        opportunityId: Awaited<ReturnType<typeof deal>>,
        scheduledAt: number,
        status: "scheduled" | "held" = "scheduled",
        closerId = harness.closerId,
      ) => insertCloserMeeting(ctx, { tenantId: harness.tenantId, closerId, opportunityId, scheduledAt, status });

      const yesterday = await meeting(await deal(), now - DAY);
      const lastWeek = await meeting(await deal(), now - 7 * DAY);
      // Still running (30 minutes long, started 10 minutes ago).
      await meeting(await deal(), now - 10 * 60_000);
      // Recorded.
      await meeting(await deal(), now - 2 * DAY, "held");
      // Its deal moved on to Follow-up, so the outcome bar is closed.
      await meeting(await deal(harness.closerId, "follow_up_scheduled"), now - 3 * DAY);
      // Its deal was reassigned to another closer.
      await meeting(await deal(harness.otherCloserId), now - 4 * DAY);
      // Another closer's call.
      await meeting(await deal(harness.otherCloserId), now - 5 * DAY, "scheduled", harness.otherCloserId);
      // Upcoming.
      await meeting(await deal(), now + HOUR);
      return { yesterday, lastWeek };
    });

    const result = await harness.closer.query(api.closer.dashboard.getMeetingsNeedingOutcome, {});

    expect(result.isPartial).toBe(false);
    expect(result.meetings.map((meeting) => meeting.meetingId)).toEqual([ids.yesterday, ids.lastWeek]);
    expect(result.meetings[0]).toMatchObject({ leadName: "Deal Person", durationMinutes: 30, programName: null });
  });

  it("names the program from the booking, else the deal's event type", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("meetings", seed.meetings[1], { scheduledAt: Date.now() - DAY });
    });
    const byEventType = await harness.closer.query(api.closer.dashboard.getMeetingsNeedingOutcome, {});
    expect(byEventType.meetings).toMatchObject([{ meetingId: seed.meetings[1], programName: "Bounded call" }]);

    await harness.t.run(async (ctx) => {
      await ctx.db.patch("meetings", seed.meetings[1], { bookingProgramName: "Elite Mentorship" });
    });
    const byBooking = await harness.closer.query(api.closer.dashboard.getMeetingsNeedingOutcome, {});
    expect(byBooking.meetings).toMatchObject([{ programName: "Elite Mentorship" }]);
  });

  it("refuses anyone but a closer", async () => {
    const harness = await closerPipelineHarness();
    await expect(
      harness.admin.query(api.closer.dashboard.getMeetingsNeedingOutcome, {}),
    ).rejects.toThrow();
  });
});
