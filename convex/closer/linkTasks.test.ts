import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { insertMeetingAggregate } from "../reporting/writeHooks";
import { insertLatestMeeting } from "../../tests/dealStageFixtures";
import {
  guardDealIn,
  guardHarness,
  insertGuardTask,
  readGuardDeal,
  type GuardHarness,
  type GuardState,
} from "../../tests/dealGuardFixtures";

// A scheduling link waiting on the person opens on the closer's task page
// (`getReminderDetail`), where "Not booking?" cancels the link
// (`cancelLinkTask`) or marks the deal lost (`markLinkTaskLost`).

const followUpWithLink: GuardState = {
  label: "follow_up_scheduled with a pending scheduling link",
  status: "follow_up_scheduled",
  source: "calendly",
  task: "scheduling_link",
};
const rescheduleLinkSent: GuardState = {
  label: "reschedule_link_sent",
  status: "reschedule_link_sent",
  source: "calendly",
  task: "reschedule_link",
};

async function linkOn(harness: GuardHarness, opportunityId: Id<"opportunities">) {
  const followUp = await harness.t.run((ctx) =>
    ctx.db
      .query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) =>
        q.eq("opportunityId", opportunityId).eq("status", "pending"),
      )
      .first(),
  );
  expect(followUp?.type).toBe("scheduling_link");
  return followUp!._id;
}

async function followUpEvents(harness: GuardHarness, followUpId: Id<"followUps">) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", harness.tenantId).eq("entityType", "followUp").eq("entityId", followUpId),
      )
      .take(10),
  );
}

async function dealEvents(harness: GuardHarness, opportunityId: Id<"opportunities">) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", harness.tenantId).eq("entityType", "opportunity").eq("entityId", opportunityId),
      )
      .take(10),
  );
}

/** A second closer in the same tenant. */
async function otherCloser(harness: GuardHarness) {
  await harness.t.run((ctx) =>
    ctx.db.insert("users", {
      tenantId: harness.tenantId,
      workosUserId: "user_other_closer",
      email: "other@example.com",
      role: "closer",
      isActive: true,
    }),
  );
  return harness.t.withIdentity({ subject: "user_other_closer", org_id: "org_test" });
}

/** A closer of another tenant. */
async function otherTenantCloser(harness: GuardHarness) {
  await harness.t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0,
      companyName: "Other",
      contactEmail: "other-closer@example.com",
      workosOrgId: "org_other",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_other_tenant_closer",
      email: "other-closer@example.com",
      role: "closer",
      isActive: true,
    });
  });
  return harness.t.withIdentity({ subject: "user_other_tenant_closer", org_id: "org_other" });
}

describe("getReminderDetail for a scheduling link", () => {
  it("returns the closer's own link with the deal, the call it followed and its URL", async () => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, rescheduleLinkSent, {
      meeting: "no_show",
    });
    const followUpId = await linkOn(harness, opportunityId);
    // The meeting the link followed happened before it was sent.
    await harness.t.run((ctx) => ctx.db.patch("meetings", meetingId!, { scheduledAt: 1_000 }));

    const detail = await harness.closer.query(api.closer.reminderDetail.getReminderDetail, {
      followUpId,
    });

    expect(detail?.followUp).toMatchObject({
      _id: followUpId,
      type: "scheduling_link",
      reason: "no_show_follow_up",
      status: "pending",
      schedulingLinkUrl: "https://calendly.com/closer/reschedule",
      createdAt: 1_200,
    });
    expect(detail?.opportunity.position).toBe("follow_up");
    expect(detail?.followedMeeting).toMatchObject({ _id: meetingId, status: "no_show" });
    expect(detail?.bookedMeeting).toBeNull();
    expect(detail?.dealMeetings.map((meeting) => meeting._id)).toEqual([meetingId]);
  });

  it("names the call a booked link made", async () => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, followUpWithLink, {
      meeting: "scheduled",
    });
    const followUpId = await linkOn(harness, opportunityId);
    await harness.t.run(async (ctx) => {
      const meeting = (await ctx.db.get("meetings", meetingId!))!;
      await ctx.db.patch("followUps", followUpId, {
        status: "booked",
        bookedAt: 2_000,
        calendlyEventUri: meeting.calendlyEventUri,
      });
    });

    const detail = await harness.closer.query(api.closer.reminderDetail.getReminderDetail, {
      followUpId,
    });

    expect(detail?.followUp.status).toBe("booked");
    expect(detail?.bookedMeeting?._id).toBe(meetingId);
  });

  it("returns nothing to another closer, to another tenant, or on the admin twin", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithLink);
    const followUpId = await linkOn(harness, opportunityId);
    const other = await otherCloser(harness);
    const outsider = await otherTenantCloser(harness);

    await expect(
      other.query(api.closer.reminderDetail.getReminderDetail, { followUpId }),
    ).resolves.toBeNull();
    await expect(
      outsider.query(api.closer.reminderDetail.getReminderDetail, { followUpId }),
    ).resolves.toBeNull();
    // The admin twin stays reminders only.
    await expect(
      harness.admin.query(api.pipeline.reminderDetail.getAdminReminderDetail, { followUpId }),
    ).resolves.toBeNull();
    await expect(
      harness.admin.query(api.closer.reminderDetail.getReminderDetail, { followUpId }),
    ).rejects.toThrow("Insufficient permissions");
  });
});

const MINUTE = 60_000;
const booked: GuardState = { label: "scheduled", status: "scheduled", source: "calendly" };

/** A meeting on the deal, counted in the aggregates so outcomes can write it. */
async function meetingOn(
  harness: GuardHarness,
  opportunityId: Id<"opportunities">,
  fields: { status: "scheduled" | "no_show" | "held"; scheduledAt: number },
) {
  return await harness.t.run(async (ctx) => {
    const meetingId = await insertLatestMeeting(ctx, opportunityId, {
      ...fields,
      createdAt: fields.scheduledAt - 7 * 24 * 60 * MINUTE,
    });
    await insertMeetingAggregate(ctx, meetingId);
    return meetingId;
  });
}

describe("the call a task follows", () => {
  it("is the 15:00 call for a link generated at 14:58, from the stored source meeting", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, booked);
    // The outcome opens 5 minutes before the call; the closer records it 2 minutes early.
    const meetingId = await meetingOn(harness, opportunityId, {
      status: "scheduled",
      scheduledAt: Date.now() + 2 * MINUTE,
    });

    const { followUpId } = await harness.closer.mutation(
      api.closer.followUpMutations.createSchedulingLinkFollowUp,
      { opportunityId, meetingId },
    );

    const followUp = await harness.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(followUp?.sourceMeetingId).toBe(meetingId);
    const detail = await harness.closer.query(api.closer.reminderDetail.getReminderDetail, {
      followUpId,
    });
    expect(detail?.followedMeeting).toMatchObject({ _id: meetingId, status: "held" });
  });

  it("falls back to the call up to 5 minutes after a link stored without one", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithLink);
    const followUpId = await linkOn(harness, opportunityId);
    // The link was created at 1_200 (insertGuardTask), before sourceMeetingId existed.
    const early = await meetingOn(harness, opportunityId, {
      status: "held",
      scheduledAt: 1_200 + 2 * MINUTE,
    });
    await meetingOn(harness, opportunityId, { status: "held", scheduledAt: 1_200 + 6 * MINUTE });

    const detail = await harness.closer.query(api.closer.reminderDetail.getReminderDetail, {
      followUpId,
    });
    expect(detail?.followedMeeting?._id).toBe(early);
  });

  it("is found for an old task whose call is behind the deal's newest 20", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithLink);
    const followUpId = await linkOn(harness, opportunityId);
    const source = await meetingOn(harness, opportunityId, { status: "no_show", scheduledAt: 1_000 });
    for (let i = 0; i < 21; i += 1) {
      await meetingOn(harness, opportunityId, { status: "held", scheduledAt: 1_000_000 + i * MINUTE });
    }

    // Without a stored source meeting: the indexed lookup, not the newest 20.
    const fallback = await harness.closer.query(api.closer.reminderDetail.getReminderDetail, {
      followUpId,
    });
    expect(fallback?.dealMeetings.some((meeting) => meeting._id === source)).toBe(false);
    expect(fallback?.followedMeeting).toMatchObject({ _id: source, status: "no_show" });

    // With one: the stored meeting.
    await harness.t.run((ctx) => ctx.db.patch("followUps", followUpId, { sourceMeetingId: source }));
    const stored = await harness.closer.query(api.closer.reminderDetail.getReminderDetail, {
      followUpId,
    });
    expect(stored?.followedMeeting?._id).toBe(source);
  });

  it("is stored by the reminder and reschedule-link create mutations", async () => {
    const harness = await guardHarness();
    const reminderDeal = await guardDealIn(harness, booked);
    const reminderMeeting = await meetingOn(harness, reminderDeal.opportunityId, {
      status: "scheduled",
      scheduledAt: Date.now() - MINUTE,
    });
    const { followUpId: reminderId } = await harness.closer.mutation(
      api.closer.followUpMutations.createManualReminderFollowUpPublic,
      {
        opportunityId: reminderDeal.opportunityId,
        meetingId: reminderMeeting,
        contactMethod: "call",
        reminderScheduledAt: Date.now() + 60 * MINUTE,
      },
    );
    const noShow: GuardState = { label: "no_show", status: "no_show", source: "calendly" };
    const noShowDeal = await guardDealIn(harness, noShow, { meeting: "no_show" });
    const { followUpId: rescheduleId } = await harness.closer.mutation(
      api.closer.noShowActions.createNoShowRescheduleLink,
      { opportunityId: noShowDeal.opportunityId, meetingId: noShowDeal.meetingId! },
    );

    const [reminder, reschedule] = await harness.t.run(async (ctx) => [
      await ctx.db.get("followUps", reminderId),
      await ctx.db.get("followUps", rescheduleId),
    ]);
    expect(reminder?.sourceMeetingId).toBe(reminderMeeting);
    expect(reschedule?.sourceMeetingId).toBe(noShowDeal.meetingId);
  });
});

describe("cancelLinkTask", () => {
  it("expires the link and leaves the deal in Follow-up", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithLink);
    const followUpId = await linkOn(harness, opportunityId);

    await harness.closer.mutation(api.closer.linkTaskOutcomes.cancelLinkTask, { followUpId });

    const followUp = await harness.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(followUp!.status).toBe("expired");
    const deal = await readGuardDeal(harness, opportunityId);
    expect({ stage: deal.stage, outcome: deal.outcome }).toEqual({ stage: "follow_up", outcome: "open" });
    expect(await dealEvents(harness, opportunityId)).toEqual([]);
    const events = await followUpEvents(harness, followUpId);
    expect(events.map((event) => [event.eventType, event.source, event.actorUserId])).toEqual([
      ["followUp.expired", "closer", harness.closerId],
    ]);
  });

  it("cancels a reschedule link too, which leaves the deal at Follow-up with no link", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, rescheduleLinkSent);
    const followUpId = await linkOn(harness, opportunityId);

    await harness.closer.mutation(api.closer.linkTaskOutcomes.cancelLinkTask, { followUpId });

    expect((await readGuardDeal(harness, opportunityId)).stage).toBe("follow_up");
    const followUp = await harness.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(followUp!.status).toBe("expired");
  });

  it("refuses another closer, another tenant, a closed link and a reminder", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithLink);
    const followUpId = await linkOn(harness, opportunityId);
    const reminderId = await harness.t.run((ctx) =>
      insertGuardTask(ctx, opportunityId, "reminder"),
    );
    const other = await otherCloser(harness);
    const outsider = await otherTenantCloser(harness);

    await expect(
      other.mutation(api.closer.linkTaskOutcomes.cancelLinkTask, { followUpId }),
    ).rejects.toThrow("Not your task");
    await expect(
      outsider.mutation(api.closer.linkTaskOutcomes.cancelLinkTask, { followUpId }),
    ).rejects.toThrow("Task not found");
    await expect(
      harness.admin.mutation(api.closer.linkTaskOutcomes.cancelLinkTask, { followUpId }),
    ).rejects.toThrow("Insufficient permissions");
    await expect(
      harness.closer.mutation(api.closer.linkTaskOutcomes.cancelLinkTask, { followUpId: reminderId }),
    ).rejects.toThrow("Only a scheduling link");
    expect((await harness.t.run((ctx) => ctx.db.get("followUps", followUpId)))!.status).toBe("pending");

    await harness.closer.mutation(api.closer.linkTaskOutcomes.cancelLinkTask, { followUpId });
    await expect(
      harness.closer.mutation(api.closer.linkTaskOutcomes.cancelLinkTask, { followUpId }),
    ).rejects.toThrow("already booked or closed");
  });
});

describe("markLinkTaskLost", () => {
  it("closes the link and the deal as lost by the closer, with the reason", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithLink);
    const followUpId = await linkOn(harness, opportunityId);

    await harness.closer.mutation(api.closer.linkTaskOutcomes.markLinkTaskLost, {
      followUpId,
      reason: "  Went with another program  ",
    });

    const deal = await readGuardDeal(harness, opportunityId);
    expect(deal).toMatchObject({
      stage: "closed",
      outcome: "lost",
      lostByUserId: harness.closerId,
      lostReason: "Went with another program",
    });
    const followUp = await harness.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(followUp).toMatchObject({
      status: "completed",
      completionOutcome: "lost",
      completionNote: "Went with another program",
      completedAt: expect.any(Number),
    });
    const lost = (await dealEvents(harness, opportunityId)).filter(
      (event) => event.eventType === "opportunity.marked_lost",
    );
    expect(lost.map((event) => [event.fromStatus, event.toStatus, event.source])).toEqual([
      ["follow_up", "closed", "closer"],
    ]);
    const [completed] = await followUpEvents(harness, followUpId);
    expect(completed).toMatchObject({ eventType: "followUp.completed", source: "closer" });
    // Reminder outcome counts read `outcome`; a link's outcome stays out of them.
    const metadata = JSON.parse(completed.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({ linkOutcome: "lost" });
    expect(metadata.outcome).toBeUndefined();
  });

  it("closes a deal waiting on its reschedule link, once the link closes with it", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, rescheduleLinkSent);
    const followUpId = await linkOn(harness, opportunityId);

    await harness.closer.mutation(api.closer.linkTaskOutcomes.markLinkTaskLost, { followUpId });

    const deal = await readGuardDeal(harness, opportunityId);
    expect({ stage: deal.stage, outcome: deal.outcome, lostReason: deal.lostReason }).toEqual({
      stage: "closed",
      outcome: "lost",
      lostReason: undefined,
    });
    expect((await harness.t.run((ctx) => ctx.db.get("followUps", followUpId)))!.status).toBe(
      "completed",
    );
  });

  it("refuses a deal that is already closed, and leaves the link pending", async () => {
    const harness = await guardHarness();
    const won: GuardState = {
      label: "payment_received",
      status: "payment_received",
      source: "calendly",
      task: "scheduling_link",
    };
    const { opportunityId } = await guardDealIn(harness, won);
    const followUpId = await linkOn(harness, opportunityId);

    await expect(
      harness.closer.mutation(api.closer.linkTaskOutcomes.markLinkTaskLost, { followUpId }),
    ).rejects.toThrow("Cannot mark lost");
    expect((await harness.t.run((ctx) => ctx.db.get("followUps", followUpId)))!.status).toBe("pending");
    expect((await readGuardDeal(harness, opportunityId)).outcome).toBe("won");
  });

  it("refuses another closer and a closer of another tenant", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithLink);
    const followUpId = await linkOn(harness, opportunityId);
    const other = await otherCloser(harness);
    const outsider = await otherTenantCloser(harness);

    await expect(
      other.mutation(api.closer.linkTaskOutcomes.markLinkTaskLost, { followUpId }),
    ).rejects.toThrow("Not your task");
    await expect(
      outsider.mutation(api.closer.linkTaskOutcomes.markLinkTaskLost, { followUpId }),
    ).rejects.toThrow("Task not found");
    expect((await readGuardDeal(harness, opportunityId)).stage).toBe("follow_up");
  });
});
