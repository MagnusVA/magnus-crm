import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { ATTENDANCE_NOW, attendanceActionFixture, attendanceStorageModes, heldAttendanceFixture } from "../../tests/showRateFixtures";
import { meetingEvidence } from "./leadLifecycle";
import { meetingsByStatus } from "../reporting/aggregates";
import { patchMeetingLifecycle } from "./meetingLifecycle";
import { recordBookingFact, reconcileBookingFact } from "../pipeline/bookingFacts";
import { deriveCallOutcomeByStage, needsRescheduleLinkCheck } from "../reporting/lib/outcomeDerivation";
import { MEETING_STATUSES, validateMeetingTransition } from "./statusTransitions";

afterEach(() => vi.useRealTimers());
const batch = { cursor: null, dryRun: false, oneBatchOnly: true };

it("keeps held and completed terminal while accepting scheduled attendance", () => {
  for (const status of ["completed", "held"] as const) {
    expect(validateMeetingTransition("scheduled", status)).toBe(true);
    for (const target of MEETING_STATUSES) {
      expect(validateMeetingTransition(status, target)).toBe(false);
    }
  }
});

it.each(attendanceStorageModes)("asserts projections with stored %s attendance during the rollout", async (storage) => {
  const { t } = await heldAttendanceFixture(storage);
  migrationsTest.register(t);
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

it("refuses to invent a held timestamp when a legacy completed meeting has none", async () => {
  const { t, meeting } = await attendanceActionFixture();
  migrationsTest.register(t);
  await t.run((ctx) => patchMeetingLifecycle(ctx, meeting._id, { status: "completed" }));
  const before = await t.run((ctx) => ctx.db.get("meetings", meeting._id));
  await expect(t.mutation(internal.migrations.backfillMeetingAttendance, batch))
    .rejects.toThrow(meeting._id);
  expect(await t.run((ctx) => ctx.db.get("meetings", meeting._id))).toEqual(before);
});

it("backfills attendance through aggregate replacement and projection enqueue, then reruns without writes", async () => {
  const { t, tenantId, closerId } = await heldAttendanceFixture("completed");
  migrationsTest.register(t);
  // The reporting fixture rewinds to the report instant after draining jobs.
  // Move past that drain before enqueueing more work: production time is monotonic.
  vi.setSystemTime(ATTENDANCE_NOW + 86_400_000);
  await t.run(async (ctx) => {
    const missed = (await ctx.db.query("meetings").take(20)).find((m) => m.status === "no_show")!;
    await patchMeetingLifecycle(ctx, missed._id, { completedAt: 123, noShowMarkedAt: 123 });
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const snapshot = () => t.run(async (ctx) => ({
    meetings: await ctx.db.query("meetings").take(20),
    projections: await ctx.db.query("meetingProjections").take(20),
    buckets: await ctx.db.query("operationsMeetingStatsV2").take(20),
    counts: await Promise.all((["completed", "held"] as const).map((status) =>
      meetingsByStatus.count(ctx, { namespace: tenantId, bounds: {
        prefix: [closerId, "new", status],
      } }),
    )),
  }));
  const before = await snapshot();
  expect(before.counts).toEqual([2, 0]);
  expect(before.buckets.filter((b) => b.meetingStatus === "completed")).toHaveLength(2);
  await expect(t.mutation(internal.migrations.assertMeetingAttendance, batch)).rejects.toThrow();
  await t.mutation(internal.migrations.backfillMeetingAttendance, batch);
  const queued = await snapshot();
  expect(queued.counts).toEqual([0, 2]);
  for (const old of before.meetings.filter((m) => m.status === "completed")) {
    const updated = queued.meetings.find((m) => m._id === old._id)!;
    expect(updated).toMatchObject({ status: "held", heldMarkedAt: old.completedAt, completedAt: old.completedAt });
    expect(meetingEvidence(updated)).toEqual(meetingEvidence(old));
    const projection = queued.projections.find((p) => p.meetingId === old._id)!;
    expect(projection.status).toBe("queued");
    const previous = before.projections.find((p) => p.meetingId === old._id)!;
    expect(projection.generation).toBe(previous.generation + (previous.status === "queued" ? 0 : 1));
  }
  const missed = queued.meetings.find((m) => m.status === "no_show")!;
  expect(missed).not.toHaveProperty("completedAt");
  expect(missed.noShowMarkedAt).toBe(123);
  await expect(t.mutation(internal.migrations.assertMeetingAttendance, batch)).rejects.toThrow();
  await t.mutation(internal.migrations.clearHeldCompletedAt, batch);
  await t.mutation(internal.migrations.assertMeetingAttendance, batch);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const after = await snapshot();
  expect(after.buckets.some((b) => b.meetingStatus === "completed" || b.bucketKey.includes('"completed"'))).toBe(false);
  expect(after.buckets.filter((b) => b.meetingStatus === "held").reduce((sum, b) => sum + b.count, 0)).toBe(2);
  for (const fn of [internal.migrations.assertMeetingProjections, internal.migrations.assertMeetingProjectionBuckets, internal.migrations.assertMeetingProjectionSources]) {
    // Bucket assertions default to one row; explicitly cover this entire small fixture.
    await t.mutation(fn, { ...batch, batchSize: 50 });
  }
  await t.mutation(internal.migrations.backfillMeetingAttendance, batch);
  expect(await snapshot()).toEqual(after);
});

it("clears completedAt without changing attendance, refs, aggregates or projections, and reruns without writes", async () => {
  const { t, tenantId, closerId } = await heldAttendanceFixture("held");
  migrationsTest.register(t);
  const snapshot = () => t.run(async (ctx) => ({
    meetings: await ctx.db.query("meetings").take(20),
    deals: await ctx.db.query("opportunities").take(20),
    projections: await ctx.db.query("meetingProjections").take(20),
    buckets: await ctx.db.query("operationsMeetingStatsV2").take(20),
    events: await ctx.db.query("domainEvents").take(20),
    heldCount: await meetingsByStatus.count(ctx, {
      namespace: tenantId, bounds: { prefix: [closerId, "new", "held"] },
    }),
  }));
  const before = await snapshot();
  expect(before.meetings.filter((meeting) => meeting.completedAt !== undefined)).toHaveLength(2);
  await expect(t.mutation(internal.migrations.clearHeldCompletedAt, { cursor: null, dryRun: true }))
    .resolves.toMatchObject({ DryRun: "No changes were committed." });
  expect(await snapshot()).toEqual(before);
  await expect(t.mutation(internal.migrations.assertMeetingAttendance, batch)).rejects.toThrow();
  await t.mutation(internal.migrations.clearHeldCompletedAt, batch);
  const after = await snapshot();
  const meetings = before.meetings.map(({ completedAt: _completedAt, ...meeting }) => meeting);
  expect(after).toEqual({ ...before, meetings });
  for (let index = 0; index < meetings.length; index++) {
    expect(meetingEvidence(meetings[index])).toEqual(meetingEvidence(before.meetings[index]));
  }
  await t.mutation(internal.migrations.assertMeetingAttendance, batch);
  await t.mutation(internal.migrations.clearHeldCompletedAt, batch);
  expect(await snapshot()).toEqual(after);
});

it.each(["scheduled", "no_show", "canceled"] as const)("also clears stray completedAt on %s meetings", async (status) => {
  const { t, meeting } = await attendanceActionFixture();
  migrationsTest.register(t);
  await t.run((ctx) => ctx.db.patch("meetings", meeting._id, { status, completedAt: 0 }));
  const before = (await t.run((ctx) => ctx.db.get("meetings", meeting._id)))!;
  await t.mutation(internal.migrations.clearHeldCompletedAt, batch);
  const { completedAt: _completedAt, ...expected } = before;
  expect(await t.run((ctx) => ctx.db.get("meetings", meeting._id))).toEqual(expected);
  await t.mutation(internal.migrations.assertMeetingAttendance, batch);
});

it.each([
  { status: "completed" as const, completedAt: 1 },
  { status: "held" as const },
  { status: "held" as const, heldMarkedAt: 1, completedAt: 1 },
  { status: "no_show" as const, completedAt: 1 },
  { status: "scheduled" as const, completedAt: 1 },
  { status: "canceled" as const, completedAt: 1 },
  { status: "scheduled" as const, heldMarkedAt: 1 },
  { status: "no_show" as const, heldMarkedAt: 1 },
  { status: "canceled" as const, heldMarkedAt: 1 },
])("rejects invalid attendance $status timestamps $completedAt / $heldMarkedAt", async (patch) => {
  const { t, meeting } = await attendanceActionFixture();
  migrationsTest.register(t);
  await t.run((ctx) => ctx.db.patch("meetings", meeting._id, patch));
  await expect(t.mutation(internal.migrations.assertMeetingAttendance, batch)).rejects.toThrow(meeting._id);
});

it.each([-60_000, 60_000, undefined])("preserves Showed time with legacy and held timestamps (%s)", async (offset) => {
  const { meeting } = await attendanceActionFixture();
  const recordedAt = offset === undefined ? undefined : meeting.scheduledAt + offset;
  const legacy = { ...meeting, status: "completed" as const, completedAt: recordedAt };
  const held = { ...legacy, status: "held" as const, heldMarkedAt: recordedAt };
  expect(meetingEvidence(held)).toEqual(meetingEvidence(legacy));
  expect(meetingEvidence(held)).toContainEqual({ stage: "showed", at: Math.min(meeting.scheduledAt, recordedAt ?? meeting.scheduledAt) });
  // The new timestamp wins when both exist.
  expect(meetingEvidence({ ...held, heldMarkedAt: meeting.scheduledAt - 120_000 })).toContainEqual({ stage: "showed", at: meeting.scheduledAt - 120_000 });
});

it.each(["closer", "admin"] as const)("%s no-show writes metadata without held/completed timestamps", async (role) => {
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

it.each(["completed", "held"] as const)("protects %s attendance against Calendly facts and derives follow-up outcomes", async (status) => {
  const { t, meeting, tenantId } = await attendanceActionFixture();
  await t.run(async (ctx) => {
    const original = await patchMeetingLifecycle(ctx, meeting._id, { status, completedAt: 10, heldMarkedAt: status === "held" ? 10 : undefined });
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
