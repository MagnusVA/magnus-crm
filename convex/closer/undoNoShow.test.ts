import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { book, enrollmentHarness, type EnrollmentHarness } from "../../tests/enrollmentFixtures";

// A lead joins after the closer marked them no-show: the closer (or an admin)
// undoes the no-show and records the call's real result.

afterEach(() => vi.useRealTimers());

// The booked call starts 2026-10-01T12:00:00Z; the lead joins ten minutes late.
const MARKED_AT = Date.parse("2026-10-01T12:10:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function noShowDeal(harness: EnrollmentHarness) {
  const deal = await book(harness, "late-join");
  vi.setSystemTime(new Date(MARKED_AT));
  await harness.closer.mutation(api.closer.noShowActions.markNoShow, {
    meetingId: deal.meetingId,
    reason: "no_response",
    note: "Waited ten minutes",
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  return deal;
}

async function rows(harness: EnrollmentHarness, deal: { meetingId: Id<"meetings">; opportunityId: Id<"opportunities"> }) {
  return await harness.t.run(async (ctx) => ({
    meeting: (await ctx.db.get("meetings", deal.meetingId))!,
    deal: (await ctx.db.get("opportunities", deal.opportunityId))!,
    events: (await ctx.db.query("domainEvents").order("asc").take(200)).map((event) => ({
      eventType: event.eventType,
      source: event.source,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
    })),
  }));
}

describe("undoNoShow", () => {
  it("lets the closer undo their no-show, then record the call as a follow-up", async () => {
    const harness = await enrollmentHarness();
    const deal = await noShowDeal(harness);

    await harness.closer.mutation(api.closer.noShowActions.undoNoShow, { meetingId: deal.meetingId });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

    const undone = await rows(harness, deal);
    expect(undone.meeting).toMatchObject({ status: "scheduled" });
    for (const field of [
      "noShowMarkedAt",
      "noShowReason",
      "noShowNote",
      "noShowMarkedByUserId",
      "noShowSource",
      "heldMarkedAt",
    ] as const)
      expect(undone.meeting[field]).toBeUndefined();
    expect(undone.deal).toMatchObject({ stage: "booked", outcome: "open" });
    // The no-show and its undo are both human results: each stands down pending proposals.
    expect(undone.deal?.humanResultRevision).toBe(2);
    expect(undone.deal.lostReason).toBeUndefined();
    expect(undone.deal.lostAt).toBeUndefined();
    expect(undone.events.slice(-2)).toEqual([
      { eventType: "meeting.no_show_reverted", source: "closer", fromStatus: "no_show", toStatus: "scheduled" },
      { eventType: "opportunity.stage_changed", source: "closer", fromStatus: "closed", toStatus: "booked" },
    ]);
    // The original no-show stays in the log.
    expect(undone.events.map((event) => event.eventType)).toContain("meeting.no_show");

    // The usual outcome action now records what happened on the call.
    await harness.closer.mutation(api.closer.followUpMutations.createManualReminderFollowUpPublic, {
      opportunityId: deal.opportunityId,
      meetingId: deal.meetingId,
      contactMethod: "call",
      reminderScheduledAt: MARKED_AT + 2 * DAY_MS,
    });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
    const recorded = await rows(harness, deal);
    expect(recorded.meeting).toMatchObject({ status: "held" });
    expect(recorded.deal).toMatchObject({ stage: "follow_up", outcome: "open" });
  });

  it("lets an admin undo a closer's no-show", async () => {
    const harness = await enrollmentHarness();
    const deal = await noShowDeal(harness);

    await harness.admin.mutation(api.closer.noShowActions.undoNoShow, { meetingId: deal.meetingId });

    const undone = await rows(harness, deal);
    expect(undone.meeting.status).toBe("scheduled");
    expect(undone.deal.stage).toBe("booked");
    expect(undone.events.at(-2)).toMatchObject({ eventType: "meeting.no_show_reverted", source: "admin" });
  });

  it("refuses another closer's meeting", async () => {
    const harness = await enrollmentHarness();
    const deal = await noShowDeal(harness);
    await harness.t.run(async (ctx) => {
      const closer = (await ctx.db.get("users", harness.closerId))!;
      const { _id, _creationTime, ...fields } = closer;
      await ctx.db.insert("users", {
        ...fields,
        workosUserId: "user_other_closer",
        email: "other-closer@example.com",
        calendlyUserUri: "https://api.calendly.com/users/other-closer",
      });
    });
    const otherCloser = harness.t.withIdentity({ subject: "user_other_closer", org_id: "org_test" });

    await expect(
      otherCloser.mutation(api.closer.noShowActions.undoNoShow, { meetingId: deal.meetingId }),
    ).rejects.toThrow("Not your meeting.");
    expect((await rows(harness, deal)).meeting.status).toBe("no_show");
  });

  it("refuses once the deal has moved on", async () => {
    const harness = await enrollmentHarness();
    const deal = await noShowDeal(harness);
    // "Schedule follow-up" on the no-show card reopens the deal without the meeting.
    await harness.closer.mutation(api.closer.followUpMutations.createManualReminderFollowUpPublic, {
      opportunityId: deal.opportunityId,
      contactMethod: "call",
      reminderScheduledAt: MARKED_AT + 2 * DAY_MS,
    });

    await expect(
      harness.closer.mutation(api.closer.noShowActions.undoNoShow, { meetingId: deal.meetingId }),
    ).rejects.toThrow("The deal has moved on since the no-show");
    expect((await rows(harness, deal)).meeting.status).toBe("no_show");
  });

  it.each([["calendly_webhook" as const], [undefined]])(
    "leaves a Calendly no-show to Calendly (source %s)",
    async (noShowSource) => {
      const harness = await enrollmentHarness();
      const deal = await noShowDeal(harness);
      // Older Calendly no-shows were written without a source.
      await harness.t.run((ctx) => ctx.db.patch("meetings", deal.meetingId, { noShowSource }));

      await expect(
        harness.closer.mutation(api.closer.noShowActions.undoNoShow, { meetingId: deal.meetingId }),
      ).rejects.toThrow("Calendly marked this no-show");
    },
  );

  it("refuses a meeting that isn't a no-show", async () => {
    const harness = await enrollmentHarness();
    const deal = await book(harness, "on-time");
    vi.setSystemTime(new Date(MARKED_AT));

    await expect(
      harness.closer.mutation(api.closer.noShowActions.undoNoShow, { meetingId: deal.meetingId }),
    ).rejects.toThrow("This call isn't marked no-show");
  });
});
