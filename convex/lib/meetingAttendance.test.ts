import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { ATTENDANCE_NOW, attendanceActionFixture, showRateFixture } from "../../tests/showRateFixtures";
import { meetingEvidence } from "./leadLifecycle";
import { patchMeetingLifecycle } from "./meetingLifecycle";
import { recordBookingFact, reconcileBookingFact } from "../pipeline/bookingFacts";
import { deriveCallOutcomeByStage, needsRescheduleLinkCheck } from "../reporting/lib/outcomeDerivation";
import { MEETING_STATUSES, validateMeetingTransition } from "./statusTransitions";

afterEach(() => vi.useRealTimers());
const batch = { cursor: null, dryRun: false, oneBatchOnly: true };

it("keeps held terminal while accepting scheduled attendance", () => {
  expect(validateMeetingTransition("scheduled", "held")).toBe(true);
  for (const target of MEETING_STATUSES) {
    expect(validateMeetingTransition("held", target)).toBe(false);
  }
});

it("asserts held attendance and projections", async () => {
  const { t } = await showRateFixture();
  migrationsTest.register(t);
  await t.mutation(internal.migrations.assertMeetingAttendance, batch);
  for (const fn of [
    internal.migrations.assertMeetingProjections,
    internal.migrations.assertMeetingProjectionBuckets,
    internal.migrations.assertMeetingProjectionSources,
  ]) {
    await t.mutation(fn, { ...batch, batchSize: 50 });
  }
  const state = await t.run(async (ctx) => ({
    meetings: await ctx.db.query("meetings").take(20),
    projections: await ctx.db.query("meetingProjections").take(20),
  }));
  for (const meeting of state.meetings) {
    const projection = state.projections.find((row) => row.meetingId === meeting._id)!;
    expect(projection.contribution?.meetingStatus).toBe(meeting.status);
    expect(JSON.parse(projection.bucketKey!)[4]).toBe(meeting.status);
  }
});

it.each([
  { status: "held" as const },
  { status: "scheduled" as const, heldMarkedAt: 1 },
  { status: "no_show" as const, heldMarkedAt: 1 },
  { status: "canceled" as const, heldMarkedAt: 1 },
])("rejects invalid attendance $status / $heldMarkedAt", async (patch) => {
  const { t, meeting } = await attendanceActionFixture();
  migrationsTest.register(t);
  await t.run((ctx) => ctx.db.patch("meetings", meeting._id, patch));
  await expect(t.mutation(internal.migrations.assertMeetingAttendance, batch)).rejects.toThrow(meeting._id);
});

it.each([-60_000, 60_000, undefined])("derives Showed time from heldMarkedAt (%s)", async (offset) => {
  const { meeting } = await attendanceActionFixture();
  const recordedAt = offset === undefined ? undefined : meeting.scheduledAt + offset;
  const held = { ...meeting, status: "held" as const, heldMarkedAt: recordedAt };
  expect(meetingEvidence(held)).toContainEqual({ stage: "showed", at: Math.min(meeting.scheduledAt, recordedAt ?? meeting.scheduledAt) });
});

it.each(["closer", "admin"] as const)("%s no-show writes metadata without a held timestamp", async (role) => {
  const { t, meeting, closer, admin } = await attendanceActionFixture();
  if (role === "closer") await closer.mutation(api.closer.noShowActions.markNoShow, { meetingId: meeting._id, reason: "no_response" });
  else await admin.mutation(api.admin.meetingActions.adminMarkNoShow, { meetingId: meeting._id, reason: "no_response" });
  const state = await t.run(async (ctx) => ({
    meeting: await ctx.db.get("meetings", meeting._id),
    deal: await ctx.db.get("opportunities", meeting.opportunityId),
    event: await ctx.db.query("domainEvents").withIndex("by_tenantId_and_eventType_and_occurredAt", (q) => q.eq("tenantId", meeting.tenantId).eq("eventType", "meeting.no_show")).unique(),
  }));
  expect(state.meeting).toMatchObject({ status: "no_show", noShowMarkedAt: ATTENDANCE_NOW, noShowSource: role === "admin" ? "admin_manual" : "closer" });
  expect(state.meeting).not.toHaveProperty("completedAt");
  expect(state.meeting).not.toHaveProperty("heldMarkedAt");
  expect(state.deal).toMatchObject({ stage: "closed", outcome: "lost", lostReason: "no_show" });
  expect(state.event).toMatchObject({ fromStatus: "scheduled", toStatus: "no_show" });
});

it("outcome completion writes only held timing and records Showed at the scheduled time", async () => {
  const { t, meeting, closer } = await attendanceActionFixture();
  await closer.mutation(api.closer.meetingActions.markAsLost, { opportunityId: meeting.opportunityId, meetingId: meeting._id });
  const state = await t.run(async (ctx) => {
    const deal = (await ctx.db.get("opportunities", meeting.opportunityId))!;
    return { meeting: await ctx.db.get("meetings", meeting._id), lead: await ctx.db.get("leads", deal.leadId) };
  });
  expect(state.meeting).toMatchObject({ status: "held", heldMarkedAt: ATTENDANCE_NOW });
  expect(state.meeting).not.toHaveProperty("completedAt");
  expect(state.lead?.lifecycleStageEnteredAt.showed).toBe(meeting.scheduledAt);
});

it("protects held attendance against Calendly facts and derives follow-up outcomes", async () => {
  const { t, meeting, tenantId } = await attendanceActionFixture();
  await t.run(async (ctx) => {
    const original = await patchMeetingLifecycle(ctx, meeting._id, { status: "held", heldMarkedAt: 10 });
    const deal = (await ctx.db.get("opportunities", meeting.opportunityId))!;
    const followUp = { ...deal, stage: "follow_up" as const };
    expect(needsRescheduleLinkCheck(original, followUp)).toBe(true);
    expect(deriveCallOutcomeByStage(original, followUp, false, false, false)).toBe("follow_up");
    expect(deriveCallOutcomeByStage(original, followUp, false, false, true)).toBe("scheduled");
    for (const [index, eventType] of ["invitee_no_show.created", "invitee_no_show.deleted", "invitee.canceled"].entries()) {
      await recordBookingFact(ctx, { tenantId, eventUri: original.calendlyEventUri, inviteeUri: original.calendlyInviteeUri, eventType, occurredAt: 20 + index, payload: {} });
      await reconcileBookingFact(ctx, tenantId, original.calendlyEventUri, original.calendlyInviteeUri);
      expect(await ctx.db.get("meetings", meeting._id)).toEqual(original);
      expect(await ctx.db.get("opportunities", deal._id)).toEqual(deal);
    }
  });
});
