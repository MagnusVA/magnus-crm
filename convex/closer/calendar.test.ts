import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import {
  MEETING_RANGE,
  seededCloserPipeline,
} from "../../tests/closerPipelineFixtures";

// The closer's calendar shows canceled meetings and each meeting's deal
// position (docs/plans/phase-5-deal-status.md §6.3, from Q1).

describe("getMeetingsForRange", () => {
  it("returns the closer's meetings in the range, canceled ones included", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { meetings } = seed;

    const calendar = await harness.closer.query(api.closer.calendar.getMeetingsForRange, MEETING_RANGE);

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

    const calendar = await harness.closer.query(api.closer.calendar.getMeetingsForRange, MEETING_RANGE);
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

    const calendar = await harness.closer.query(api.closer.calendar.getMeetingsForRange, MEETING_RANGE);
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

  it("refuses a range that ends before it starts", async () => {
    const { harness } = await seededCloserPipeline();
    await expect(
      harness.closer.query(api.closer.calendar.getMeetingsForRange, {
        startDate: MEETING_RANGE.endDate,
        endDate: MEETING_RANGE.startDate,
      }),
    ).rejects.toThrow("startDate must be earlier than endDate");
  });
});
