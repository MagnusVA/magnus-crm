import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  DAY,
  HOUR,
  insertCloserMeeting,
  insertTask,
  seededCloserPipeline,
  T0,
} from "../../tests/closerPipelineFixtures";

// The task page: the closer's own pending or completed reminder, with the
// deal's calls and credit for the deal card. The admin twin reads the same
// cards for any reminder in the tenant.

async function seededReminder() {
  const { harness, seed } = await seededCloserPipeline();
  const { followUpId, olderMeetingId } = await harness.t.run(async (ctx) => {
    const followUpId = await insertTask(ctx, {
      opportunityId: seed.deals.reminder,
      type: "manual_reminder",
      reason: "closer_initiated",
      status: "pending",
      reminderScheduledAt: T0 + 2 * DAY,
    });
    // An earlier call on the same deal, before the held one the seed made.
    const olderMeetingId = await insertCloserMeeting(ctx, {
      tenantId: harness.tenantId,
      opportunityId: seed.deals.reminder,
      closerId: harness.closerId,
      status: "no_show",
      scheduledAt: T0 - 3 * DAY,
    });
    return { followUpId, olderMeetingId };
  });
  return { harness, seed, followUpId, olderMeetingId };
}

describe("getReminderDetail", () => {
  it("returns the deal's calls newest first, its credit and its closer", async () => {
    const { harness, seed, followUpId, olderMeetingId } = await seededReminder();

    const detail = await harness.closer.query(api.closer.reminderDetail.getReminderDetail, {
      followUpId,
    });

    expect(detail?.followUp._id).toBe(followUpId);
    expect(detail?.opportunity.position).toBe("follow_up");
    expect(detail?.dealMeetings.map((meeting) => meeting._id)).toEqual([
      seed.meetings.reminder,
      olderMeetingId,
    ]);
    expect(detail?.dealMeetings[0]).toEqual({
      _id: seed.meetings.reminder,
      scheduledAt: T0 - DAY,
      durationMinutes: 30,
      status: "held",
      detail: null,
    });
    expect(detail?.dealAttribution.credits).toEqual(expect.any(Array));
    expect(detail?.dealCloser?.email).toEqual(expect.any(String));
    expect(detail?.attributionTeam).toBeNull();
    expect(detail?.dmCloser).toBeNull();
  });

  it("gives each call one line: the no-show's note, else the newest comment", async () => {
    const { harness, seed, followUpId, olderMeetingId } = await seededReminder();
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("meetings", olderMeetingId, { noShowReason: "no_response", noShowNote: "Phone off" });
      const comment = (content: string, createdAt: number, deletedAt?: number) =>
        ctx.db.insert("meetingComments", {
          tenantId: harness.tenantId,
          meetingId: seed.meetings.reminder,
          authorId: harness.closerId,
          content,
          createdAt,
          ...(deletedAt ? { deletedAt } : {}),
        });
      await comment("Wants to check with family", T0 - DAY + 1);
      await comment("Deleted note", T0 - DAY + 2, T0);
    });

    const detail = await harness.closer.query(api.closer.reminderDetail.getReminderDetail, {
      followUpId,
    });

    expect(detail?.dealMeetings.map((meeting) => meeting.detail)).toEqual([
      "Wants to check with family",
      "Phone off",
    ]);
  });

  it("lists only this deal's calls", async () => {
    const { harness, seed, followUpId } = await seededReminder();

    const detail = await harness.closer.query(api.closer.reminderDetail.getReminderDetail, {
      followUpId,
    });

    const otherDealMeetings: Id<"meetings">[] = [seed.meetings.won, seed.meetings.booked];
    expect(
      detail?.dealMeetings.some((meeting) => otherDealMeetings.includes(meeting._id)),
    ).toBe(false);
  });

  it("returns nothing for another closer's reminder, and the closer's own scheduling link", async () => {
    const { harness, seed } = await seededReminder();
    const { othersReminder, link } = await harness.t.run(async (ctx) => {
      const othersReminder = await insertTask(ctx, {
        opportunityId: seed.deals.otherClosers,
        type: "manual_reminder",
        reason: "closer_initiated",
        status: "pending",
        reminderScheduledAt: T0 + HOUR,
      });
      const link = await insertTask(ctx, {
        opportunityId: seed.deals.reminder,
        type: "scheduling_link",
        reason: "closer_initiated",
        status: "pending",
      });
      return { othersReminder, link };
    });

    await expect(
      harness.closer.query(api.closer.reminderDetail.getReminderDetail, {
        followUpId: othersReminder,
      }),
    ).resolves.toBeNull();
    // A scheduling link opens on the task page too.
    const linkDetail = await harness.closer.query(api.closer.reminderDetail.getReminderDetail, {
      followUpId: link,
    });
    expect(linkDetail?.followUp).toMatchObject({ _id: link, type: "scheduling_link" });
  });
});

describe("getAdminReminderDetail", () => {
  it("returns the same deal cards, and the task's closer as before", async () => {
    const { harness, seed, followUpId, olderMeetingId } = await seededReminder();

    const detail = await harness.admin.query(
      api.pipeline.reminderDetail.getAdminReminderDetail,
      { followUpId },
    );

    expect(detail?.dealMeetings.map((meeting) => meeting._id)).toEqual([
      seed.meetings.reminder,
      olderMeetingId,
    ]);
    expect(detail?.dealCloser?.email).toEqual(expect.any(String));
    // `assignedCloser` stays the task closer's identity for the admin page.
    expect(detail?.assignedCloser).toMatchObject({ name: expect.any(String) });
  });
});
