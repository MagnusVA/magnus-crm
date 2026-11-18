import { describe, expect, it, vi } from "vitest";
import { getConvexSize } from "convex/values";
import { api } from "../_generated/api";
import { meetingAttendanceDisplay } from "../../lib/status-config";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import { FIXTURE_NOW, insertProviderFact, insertProviderMeeting, paymentConfirmationFixture } from "../../tests/providerPaymentFixtures";
import { evaluateSubject } from "../automation/decisions";
import { readCloserMeetingDeals } from "./dashboard";
import { closerBoundedReadFixture } from "../../tests/closerBoundedReadFixtures";
import {
  closerPipelineHarness,
  DAY,
  HOUR,
  insertCloserDeal,
  insertCloserMeeting,
  insertTask,
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

  it("leaves the system's losses out of the win rate", async () => {
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
    const result = await harness.closer.query(api.closer.dashboard.getNextMeeting, { from: now });
    expect(result).toMatchObject({
      meeting: { _id: seed.meetings[1] }, opportunity: { _id: seed.ownDeal },
      lead: { email: "deal-person@example.com" }, eventTypeName: "Bounded call",
    });
  });

  it("returns incomplete after 25 ineligible candidates even when a later one qualifies", async () => {
    const harness = await closerPipelineHarness();
    const now = Date.now();
    await harness.t.run(async (ctx) => {
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
    await expect(
      harness.closer.query(api.closer.dashboard.getNextMeeting, { from: now }),
    ).resolves.toEqual({ meeting: null, incomplete: true });
  });

  it("returns null when the scheduled candidates are exhausted below 25", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    const now = Date.now();
    await harness.t.run(async (ctx) => {
      // The closer's call is before `from`; the later one is a reassigned deal's.
      await ctx.db.patch("meetings", seed.meetings[1], { scheduledAt: now - HOUR });
      await ctx.db.patch("meetings", seed.meetings[2], { scheduledAt: now + 60_000 });
    });
    await expect(
      harness.closer.query(api.closer.dashboard.getNextMeeting, { from: now }),
    ).resolves.toBeNull();
  });

  it("reads from `from`, not from the clock", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    const dayEnd = Date.now() + 6 * HOUR;
    await harness.t.run(async (ctx) => {
      // Later today, then tomorrow: Today asks from the end of the day.
      await ctx.db.patch("meetings", seed.meetings[1], { scheduledAt: dayEnd - HOUR });
      await insertCloserMeeting(ctx, {
        tenantId: harness.tenantId, closerId: harness.closerId, opportunityId: seed.ownDeal,
        scheduledAt: dayEnd + 2 * HOUR, status: "scheduled",
      });
    });
    const result = await harness.closer.query(api.closer.dashboard.getNextMeeting, { from: dayEnd });
    expect(result).toMatchObject({ meeting: { scheduledAt: dayEnd + 2 * HOUR } });
  });
});

describe("getMeetingsNeedingOutcome", () => {
  it("lists the closer's calls with no result before `before`, newest first, on deals still awaiting one", async () => {
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
      // Later today: in the list, for the client to show once it has ended.
      const laterToday = await meeting(await deal(), now + HOUR);
      // Recorded.
      await meeting(await deal(), now - 2 * DAY, "held");
      // Its deal moved on to Follow-up, so the outcome bar is closed.
      await meeting(await deal(harness.closerId, "follow_up_scheduled"), now - 3 * DAY);
      // Its deal was reassigned to another closer.
      await meeting(await deal(harness.otherCloserId), now - 4 * DAY);
      // Another closer's call.
      await meeting(await deal(harness.otherCloserId), now - 5 * DAY, "scheduled", harness.otherCloserId);
      // After `before`: tomorrow's call.
      await meeting(await deal(), now + DAY);
      return { yesterday, lastWeek, laterToday };
    });

    const result = await harness.closer.query(api.closer.dashboard.getMeetingsNeedingOutcome, {
      before: now + 6 * HOUR,
    });

    expect(result.isPartial).toBe(false);
    expect(result.meetings.map((meeting) => meeting.meetingId)).toEqual([
      ids.laterToday,
      ids.yesterday,
      ids.lastWeek,
    ]);
    expect(result.meetings[1]).toMatchObject({ leadName: "Deal Person", durationMinutes: 30, programName: null });
  });

  it("names the program from the booking, else the deal's event type", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("meetings", seed.meetings[1], { scheduledAt: Date.now() - DAY });
    });
    const byEventType = await harness.closer.query(api.closer.dashboard.getMeetingsNeedingOutcome, { before: Date.now() });
    expect(byEventType.meetings).toMatchObject([{ meetingId: seed.meetings[1], programName: "Bounded call" }]);

    await harness.t.run(async (ctx) => {
      await ctx.db.patch("meetings", seed.meetings[1], { bookingProgramName: "Elite Mentorship" });
    });
    const byBooking = await harness.closer.query(api.closer.dashboard.getMeetingsNeedingOutcome, { before: Date.now() });
    expect(byBooking.meetings).toMatchObject([{ programName: "Elite Mentorship" }]);
  });

  it("lists older attendance before a reminder ask and ordinary calls, and counts the ask as ended", async () => {
    const f = await paymentConfirmationFixture({ dealPosition: "follow_up" });
    const followUpId = await f.t.run((ctx) => insertTask(ctx, {
      opportunityId: f.dealId, type: "manual_reminder", reason: "closer_initiated",
      status: "pending", reminderScheduledAt: FIXTURE_NOW + DAY,
    }));
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const { decisionId } = await f.t.run((ctx) => evaluateSubject(ctx, {
      tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, now: FIXTURE_NOW, cause: "sweep",
    }));
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const attendanceFixture = await f.t.run(async (ctx) => {
      const opportunityId = await insertCloserDeal(ctx, { ...f, status: "scheduled", createdAt: FIXTURE_NOW - 20 * DAY });
      const meetingId = await insertProviderMeeting(ctx, { ...f, opportunityId, scheduledAt: FIXTURE_NOW - 10 * DAY });
      const paymentId = await insertProviderFact(ctx, f.tenantId, f.connectionId, {
        externalPaymentId: "pay_attendance_fixture", reviewState: "needs_person",
      });
      await seedProviderWin(ctx, {
        ...f, opportunityId, providerPaymentId: paymentId, approverId: f.adminId, recordedAt: FIXTURE_NOW - 10 * DAY,
      });
      return meetingId;
    });
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const ordinary = await f.t.run(async (ctx) => {
      const meetings = [];
      for (let i = 1; i <= 50; i++) {
        const opportunityId = await insertCloserDeal(ctx, { ...f, status: "scheduled", createdAt: FIXTURE_NOW - 20 * DAY });
        meetings.push(await insertCloserMeeting(ctx, {
          ...f, opportunityId, status: "scheduled", scheduledAt: FIXTURE_NOW - HOUR - i * 1000,
        }));
      }
      return meetings;
    });
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const result = await f.closer.query(api.closer.dashboard.getMeetingsNeedingOutcome, { before: FIXTURE_NOW + HOUR });
    expect(result.meetings.slice(0, 2)).toMatchObject([
      { rowKind: "attendance", meetingId: attendanceFixture },
      { rowKind: "whop_ask", decisionId, followUpId, href: `/workspace/closer/reminders/${followUpId}` },
    ]);
    expect(result.meetings.slice(2).map((row) => row.meetingId)).toEqual(ordinary.slice(0, 30));
    expect(result.meetings.filter((row) => meetingAttendanceDisplay({ ...row, status: "scheduled" }, FIXTURE_NOW) === "not_recorded"))
      .toHaveLength(32);
    expect(result).toMatchObject({ isPartial: true, attendancePartial: false });
  });

  it("probes the separate attendance cap and hides a stale marker on an open deal", async () => {
    const f = await paymentConfirmationFixture();
    const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const before = FIXTURE_NOW;
    const { ids, secondDeal, secondPayment } = await f.t.run(async (ctx) => {
      const secondDeal = await insertCloserDeal(ctx, { ...f, status: "scheduled", createdAt: before - 2 * DAY });
      const secondPayment = await insertProviderFact(ctx, f.tenantId, f.connectionId, {
        externalPaymentId: "pay_second_debt", reviewState: "needs_person",
      });
      const staleDeal = await insertCloserDeal(ctx, { ...f, status: "follow_up_scheduled", createdAt: before - 2 * DAY });
      const stale = await insertCloserMeeting(ctx, {
        ...f, opportunityId: staleDeal, status: "scheduled", scheduledAt: before - DAY,
      });
      await ctx.db.patch("meetings", stale, { attendanceOwedSince: before - DAY + HOUR / 2 });
      const ids = [];
      for (let i = 1; i <= 33; i++) {
        ids.push(await insertProviderMeeting(ctx, {
          ...f, opportunityId: i <= 17 ? f.dealId : secondDeal, scheduledAt: before - DAY + i * HOUR / 10,
        }));
      }
      return { ids, secondDeal, secondPayment };
    });
    await invariant();
    await f.t.run((ctx) => seedProviderWin(ctx, {
      ...f, opportunityId: f.dealId, approverId: f.adminId, recordedAt: before - DAY,
    }));
    await invariant();
    await f.t.run((ctx) => seedProviderWin(ctx, {
      ...f, opportunityId: secondDeal, providerPaymentId: secondPayment, approverId: f.adminId, recordedAt: before - DAY,
    }));
    await invariant();
    const result = await f.closer.query(api.closer.dashboard.getMeetingsNeedingOutcome, { before });
    expect(result).toMatchObject({ isPartial: true, attendancePartial: true });
    expect(result.meetings.filter((row) => row.rowKind === "attendance").map((row) => row.meetingId)).toEqual(ids.slice(0, 30));
  });

  it("refuses anyone but a closer", async () => {
    const harness = await closerPipelineHarness();
    await expect(
      harness.admin.query(api.closer.dashboard.getMeetingsNeedingOutcome, { before: Date.now() }),
    ).rejects.toThrow();
  });
});
