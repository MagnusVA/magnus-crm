import { describe, expect, it, vi } from "vitest";
import { getConvexSize } from "convex/values";
import { api } from "../_generated/api";
import { readCloserCalendarMeetings } from "./calendar";
import { closerBoundedReadFixture } from "../../tests/closerBoundedReadFixtures";
import {
  DAY,
  MEETING_RANGE,
  seededCloserPipeline,
  T0,
} from "../../tests/closerPipelineFixtures";

// The closer's calendar shows canceled meetings and each meeting's deal
// position (docs/plans/phase-5-deal-status.md §6.3, from Q1).

describe("getMeetingsForRange", () => {
  it("returns the closer's meetings in the range, canceled ones included", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { meetings } = seed;

    const { meetings: calendar, isPartial } = await harness.closer.query(api.closer.calendar.getMeetingsForRange, MEETING_RANGE);

    expect(isPartial).toBe(false);

    // The reminder deal's meeting is before the range; the other closer's
    // meeting isn't the closer's.
    expect(calendar.map(({ meeting }) => meeting._id).sort()).toEqual(
      [
        meetings.bookedOld,
        meetings.booked,
        meetings.linkSent,
        meetings.won,
        meetings.lostByCloser,
        meetings.noShow,
        meetings.canceled,
      ].sort(),
    );
  });

  it("gives each meeting its deal's position and the loss the system wrote on the deal", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { meetings } = seed;

    const { meetings: calendar } = await harness.closer.query(api.closer.calendar.getMeetingsForRange, MEETING_RANGE);
    const byId = new Map(calendar.map((entry) => [entry.meeting._id, entry]));

    // A Calendly reschedule: the old slot canceled beside the new one, the
    // deal still Booked.
    expect(byId.get(meetings.bookedOld)).toMatchObject({
      meeting: { status: "canceled" },
      dealPosition: "booked",
      dealSystemLoss: null,
    });
    expect(byId.get(meetings.booked)).toMatchObject({
      meeting: { status: "scheduled" },
      dealPosition: "booked",
      dealSystemLoss: null,
    });
    // A no-show the closer sent a reschedule link from: the deal goes on.
    expect(byId.get(meetings.linkSent)).toMatchObject({
      meeting: { status: "no_show" },
      dealPosition: "follow_up",
      dealSystemLoss: null,
    });
    expect(byId.get(meetings.won)).toMatchObject({ dealPosition: "won", dealSystemLoss: null });
    expect(byId.get(meetings.lostByCloser)).toMatchObject({ dealPosition: "lost", dealSystemLoss: null });
    expect(byId.get(meetings.noShow)).toMatchObject({
      meeting: { status: "no_show" },
      dealPosition: "lost",
      dealSystemLoss: "no_show",
    });
    expect(byId.get(meetings.canceled)).toMatchObject({
      meeting: { status: "canceled" },
      dealPosition: "lost",
      dealSystemLoss: "canceled",
    });
  });

  it("returns what the calendar draws, with the deal's stage", async () => {
    const { harness, seed } = await seededCloserPipeline();

    const { meetings: calendar } = await harness.closer.query(api.closer.calendar.getMeetingsForRange, MEETING_RANGE);
    const booked = calendar.find(({ meeting }) => meeting._id === seed.meetings.booked)!;

    expect(Object.keys(booked).sort()).toEqual(
      ["dealOutcome", "dealPosition", "dealStage", "dealSystemLoss", "eventTypeName", "leadName", "meeting"].sort(),
    );
    expect(booked).toMatchObject({
      leadName: "Deal Person",
      eventTypeName: null,
      meeting: { durationMinutes: 30 },
      dealStage: "booked",
      dealOutcome: "open",
    });
  });

  it("gives a won deal its collected amount, without disputed payments or deposits", async () => {
    const { harness, seed } = await seededCloserPipeline();
    await harness.t.run(async (ctx) => {
      const programId = await ctx.db.insert("tenantPrograms", {
        tenantId: harness.tenantId,
        name: "Accelerator",
        normalizedName: "accelerator",
        createdAt: T0,
        createdByUserId: harness.closerId,
        updatedAt: T0,
      });
      const payment = (
        amountMinor: number,
        paymentType: "pif" | "split" | "deposit",
        status: "recorded" | "verified" | "disputed",
      ) =>
        ctx.db.insert("paymentRecords", {
          tenantId: harness.tenantId,
          opportunityId: seed.deals.won,
          attributedCloserId: harness.closerId,
          recordedByUserId: harness.closerId,
          amountMinor,
          currency: "USD",
          programId,
          programName: "Accelerator",
          paymentType,
          status,
          recordedAt: T0 + 2 * DAY,
          origin: "closer_meeting",
        });
      await payment(250_000, "split", "recorded");
      await payment(100_000, "split", "verified");
      await payment(50_000, "deposit", "recorded");
      await payment(70_000, "pif", "disputed");
    });

    const { meetings: calendar } = await harness.closer.query(api.closer.calendar.getMeetingsForRange, MEETING_RANGE);
    const byId = new Map(calendar.map((entry) => [entry.meeting._id, entry]));

    expect(byId.get(seed.meetings.won)?.wonAmount).toEqual({ amountMinor: 350_000, currency: "USD" });
    // Open and lost deals carry no amount.
    expect(byId.get(seed.meetings.booked)).not.toHaveProperty("wonAmount");
    expect(byId.get(seed.meetings.lostByCloser)).not.toHaveProperty("wonAmount");
  });

  it("refuses a range that ends before it starts", async () => {
    const { harness } = await seededCloserPipeline();
    await expect(
      harness.closer.query(api.closer.calendar.getMeetingsForRange, {
        startDate: MEETING_RANGE.endDate,
        endDate: MEETING_RANGE.startDate,
      }),
    ).rejects.toThrow("startDate must be earlier than endDate");
  });

  it("rejects more than 45 days but allows the full 45-day boundary", async () => {
    const { harness } = await closerBoundedReadFixture();
    await expect(harness.closer.query(api.closer.calendar.getMeetingsForRange, {
      startDate: T0, endDate: T0 + 45 * DAY + 1,
    })).rejects.toThrow("Calendar range cannot exceed 45 days");
    const result = await harness.closer.query(api.closer.calendar.getMeetingsForRange, {
      startDate: T0, endDate: T0 + 45 * DAY,
    });
    expect(result.meetings).toHaveLength(3);
    expect(result.isPartial).toBe(false);
  });

  it("caps the meeting rows while keeping canceled meetings", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    const result = await harness.t.run((ctx) =>
      readCloserCalendarMeetings(ctx, harness.tenantId, harness.closerId, T0, T0 + 10, 2),
    );
    expect(result.isPartial).toBe(true);
    expect(result.meetings.map(({ meeting }) => meeting._id)).toEqual(seed.meetings.slice(0, 2));
    expect(result.meetings[0].meeting.status).toBe("canceled");
  });

  it("deduplicates deal and event type joins and keeps reassigned deals' labels", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    await harness.t.run(async (ctx) => {
      const get = vi.spyOn(ctx.db, "get");
      const result = await readCloserCalendarMeetings(ctx, harness.tenantId, harness.closerId, T0, T0 + 10, 3);
      expect(result.isPartial).toBe(false);
      expect(result.meetings.map((meeting) => meeting.eventTypeName)).toEqual(["Bounded call", "Bounded call", "Bounded call"]);
      expect(result.meetings[2].dealPosition).toBe("booked");
      expect(get.mock.calls).toEqual([
        ["opportunities", seed.ownDeal], ["opportunities", seed.reassignedDeal],
        ["eventTypeConfigs", seed.eventTypeConfigId],
      ]);
    });
  });

  it("reports partial at the byte budget below the row cap", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    await harness.t.run(async (ctx) => {
      const first = (await ctx.db.get("meetings", seed.meetings[0]))!;
      const result = await readCloserCalendarMeetings(ctx, harness.tenantId, harness.closerId, T0, T0 + 10, 10, getConvexSize(first));
      expect(result.isPartial).toBe(true);
      expect(result.meetings).toHaveLength(1);
    });
  });

  it("keeps missing-deal labels and the meeting's name fallback", async () => {
    const { harness, seed } = await closerBoundedReadFixture();
    await harness.t.run(async (ctx) => {
      await ctx.db.delete("opportunities", seed.ownDeal);
      await ctx.db.patch("meetings", seed.meetings[0], { leadName: undefined });
    });
    const result = await harness.closer.query(api.closer.calendar.getMeetingsForRange, {
      startDate: T0, endDate: T0 + 10,
    });
    expect(result.isPartial).toBe(false);
    expect(result.meetings[0]).toMatchObject({
      meeting: { _id: seed.meetings[0], status: "canceled" },
      leadName: "Unknown", eventTypeName: null,
      dealStage: null, dealOutcome: null, dealPosition: null, dealSystemLoss: null,
    });
  });

  it("returns a complete empty result when the range has no meetings", async () => {
    const { harness } = await closerBoundedReadFixture();
    await expect(harness.closer.query(api.closer.calendar.getMeetingsForRange, {
      startDate: T0 + DAY, endDate: T0 + 2 * DAY,
    })).resolves.toEqual({ meetings: [], isPartial: false });
  });
});
