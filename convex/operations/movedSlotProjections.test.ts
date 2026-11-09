/**
 * The post-deploy step for moved slots (docs/reviews/reports-decisions.html,
 * D9): canceled meetings replaced before the `moved` status existed still
 * count as canceled until the re-queue runs their projections again.
 */
import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { insertMeetingAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

const NOW = Date.parse("2026-11-08T12:00:00Z");
const DAY = 24 * 3_600_000;

type Harness = Awaited<ReturnType<typeof bookingHarness>>;
type Fixture = Harness & { opportunityId: Id<"opportunities">; closerId: Id<"users"> };

async function setup(): Promise<Fixture> {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const h = await bookingHarness();
  const ids = await h.t.run(async (ctx) => {
    const closer = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
      .unique();
    const leadId = await ctx.db.insert("leads", {
      tenantId: h.tenantId, ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId: h.tenantId, leadId, stage: "booked", outcome: "open", source: "calendly",
      assignedCloserId: closer!._id, createdAt: 0, updatedAt: 0,
    });
    await insertOpportunityAggregate(ctx, opportunityId);
    return { opportunityId, closerId: closer!._id };
  });
  return { ...h, ...ids };
}

let index = 0;
/** A meeting with its aggregate, which requests its own projection and no other. */
async function meeting(
  ctx: MutationCtx,
  f: Fixture,
  at: string,
  status: Doc<"meetings">["status"],
  replaces?: Id<"meetings">,
) {
  index += 1;
  const scheduledAt = Date.parse(at);
  const meetingId = await ctx.db.insert("meetings", {
    tenantId: f.tenantId, opportunityId: f.opportunityId, assignedCloserId: f.closerId,
    calendlyEventUri: `https://api.calendly.com/scheduled_events/m${index}`,
    calendlyInviteeUri: `https://api.calendly.com/scheduled_events/m${index}/invitees/person`,
    scheduledAt, durationMinutes: 30, status, callClassification: "new", createdAt: scheduledAt - DAY,
    ...(replaces ? { rescheduledFromMeetingId: replaces } : {}),
  });
  await insertMeetingAggregate(ctx, meetingId);
  return meetingId;
}

/**
 * Two slots moved in different months, written the way the code before this
 * change left them: the successor's insert never re-projected the slot it
 * replaced. A plain cancellation and a held call sit beside them.
 */
async function legacyFixture() {
  const f = await setup();
  const ids = await f.t.run(async (ctx) => ({
    octoberSlot: await meeting(ctx, f, "2026-10-14T15:00:00Z", "canceled"),
    novemberSlot: await meeting(ctx, f, "2026-11-03T15:00:00Z", "canceled"),
    plainCancel: await meeting(ctx, f, "2026-11-04T15:00:00Z", "canceled"),
    held: await meeting(ctx, f, "2026-11-05T15:00:00Z", "held"),
  }));
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  await f.t.run(async (ctx) => {
    await meeting(ctx, f, "2026-10-16T15:00:00Z", "held", ids.octoberSlot);
    await meeting(ctx, f, "2026-11-10T15:00:00Z", "scheduled", ids.novemberSlot);
  });
  // Workpool timers advance the clock; it never goes back.
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  return { ...f, ...ids };
}

async function projectedStatus(h: Fixture, meetingId: Id<"meetings">) {
  const projection = await h.t.run((ctx) =>
    ctx.db.query("meetingProjections").withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId)).unique(),
  );
  return projection?.contribution?.meetingStatus;
}

it("re-queues only the moved slots, and writes nothing on a dry run", async () => {
  const h = await legacyFixture();
  expect(await projectedStatus(h, h.octoberSlot)).toBe("canceled");
  expect(await projectedStatus(h, h.novemberSlot)).toBe("canceled");

  const dryRun = await h.t.mutation(internal.operations.movedSlotProjections.requeueMovedSlotProjections, {
    tenantId: h.tenantId,
    dryRun: true,
  });
  expect(dryRun).toEqual({
    isDone: true,
    continueCursor: null,
    scanned: 3,
    moved: 2,
    skippedNoDeal: 0,
    byMonth: { "2026-10": 1, "2026-11": 1 },
  });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await projectedStatus(h, h.octoberSlot)).toBe("canceled");
  await expect(
    h.t.mutation(internal.operations.movedSlotProjections.assertMovedSlotProjections, { tenantId: h.tenantId }),
  ).rejects.toThrow("Moved slot projection mismatch on 2026-10-14");

  const run = await h.t.mutation(internal.operations.movedSlotProjections.requeueMovedSlotProjections, {
    tenantId: h.tenantId,
  });
  expect(run).toMatchObject({ isDone: true, moved: 2 });
  // The assert waits for the projections to drain.
  await expect(
    h.t.mutation(internal.operations.movedSlotProjections.assertMovedSlotProjections, { tenantId: h.tenantId }),
  ).rejects.toThrow("Meeting projections are queued");
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await projectedStatus(h, h.octoberSlot)).toBe("moved");
  expect(await projectedStatus(h, h.novemberSlot)).toBe("moved");
  expect(await projectedStatus(h, h.plainCancel)).toBe("canceled");
  // One 31-day window covers Oct 14 (the first slot) through Nov 10 (the last bucket).
  const check = await h.t.mutation(internal.operations.movedSlotProjections.assertMovedSlotProjections, {
    tenantId: h.tenantId,
  });
  expect(check).toEqual({ isDone: true, nextFromDayKey: null, days: 3, moved: 2, canceled: 1 });
});

it.each(["missing", "other_tenant"] as const)("skips a moved slot whose deal is %s in dry runs and requeues", async (kind) => {
  const h = await setup();
  await h.t.run(async ctx => {
    const { _id, _creationTime, ...deal } = (await ctx.db.get("opportunities", h.opportunityId))!;
    void _id; void _creationTime;
    const tenantId = await ctx.db.insert("tenants", { companyName: "Other", contactEmail: "other@example.invalid",
      workosOrgId: "other", status: "active", inviteExpiresAt: 0, createdBy: "test" });
    const opportunityId = await ctx.db.insert("opportunities", { ...deal, tenantId });
    if (kind === "missing") await ctx.db.delete("opportunities", opportunityId);
    // Legacy orphaned source rows have no projection yet.
    const meetingId = await ctx.db.insert("meetings", { tenantId: h.tenantId, opportunityId, assignedCloserId: h.closerId,
      calendlyEventUri: "orphan", calendlyInviteeUri: "orphan-invitee", scheduledAt: NOW, durationMinutes: 30,
      status: "canceled", createdAt: NOW });
    await ctx.db.insert("meetings", { tenantId: h.tenantId, opportunityId: h.opportunityId, assignedCloserId: h.closerId,
      calendlyEventUri: "successor", calendlyInviteeUri: "successor-invitee", scheduledAt: NOW + DAY, durationMinutes: 30,
      status: "scheduled", createdAt: NOW, rescheduledFromMeetingId: meetingId });
  });
  const expected = { isDone: true, continueCursor: null, scanned: 1, moved: 0, skippedNoDeal: 1, byMonth: {} };
  const dryRun = await h.t.mutation(internal.operations.movedSlotProjections.requeueMovedSlotProjections, { tenantId: h.tenantId, dryRun: true });
  expect(dryRun).toEqual(expected);
  const run = await h.t.mutation(internal.operations.movedSlotProjections.requeueMovedSlotProjections, { tenantId: h.tenantId });
  expect(run).toEqual(dryRun);
  expect(await h.t.run(ctx => ctx.db.query("meetingProjections").take(10))).toEqual([]);
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  await expect(h.t.mutation(internal.operations.movedSlotProjections.assertMovedSlotProjections, { tenantId: h.tenantId }))
    .resolves.toMatchObject({ isDone: true, moved: 0, canceled: 0 });
});

it("carries skipped deal totals into the scheduled page and completion log", async () => {
  const h = await setup();
  await h.t.run(async ctx => {
    const base = { tenantId: h.tenantId, opportunityId: h.opportunityId, assignedCloserId: h.closerId,
      calendlyEventUri: "event", calendlyInviteeUri: "invitee", scheduledAt: NOW, durationMinutes: 30, createdAt: NOW };
    for (let i = 0; i < 101; i++) {
      const id = await ctx.db.insert("meetings", { ...base, status: "canceled", scheduledAt: NOW + i });
      if (i === 0 || i === 100) await ctx.db.insert("meetings", { ...base, status: "scheduled", rescheduledFromMeetingId: id });
    }
    await ctx.db.delete("opportunities", h.opportunityId);
  });
  const info = vi.spyOn(console, "info");
  try {
    const first = await h.t.mutation(internal.operations.movedSlotProjections.requeueMovedSlotProjections, { tenantId: h.tenantId, dryRun: true });
    expect(first).toMatchObject({ isDone: false, scanned: 100, moved: 0, skippedNoDeal: 1, byMonth: {} });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    const completed = info.mock.calls.map(call => String(call[0])).find(line => line.includes("operations.moved_slots.requeue.completed"));
    expect(completed).toBeDefined();
    expect(JSON.parse(completed!.slice(completed!.indexOf("{")))).toMatchObject({ scanned: 101, moved: 0, skippedNoDeal: 2, byMonth: "{}" });
    expect(await h.t.run(ctx => ctx.db.query("meetingProjections").take(10))).toEqual([]);
  } finally { info.mockRestore(); }
});

it("passes over every window after the re-queue and fails on a planted mismatch", async () => {
  const h = await legacyFixture();
  await h.t.mutation(internal.operations.movedSlotProjections.requeueMovedSlotProjections, { tenantId: h.tenantId });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);

  // A window before the first slot checks nothing and hands on the next one.
  const early = await h.t.mutation(internal.operations.movedSlotProjections.assertMovedSlotProjections, {
    tenantId: h.tenantId,
    fromDayKey: "2026-09-01",
    once: true,
  });
  expect(early).toEqual({ isDone: false, nextFromDayKey: "2026-10-02", days: 0, moved: 0, canceled: 0 });
  // Left to chain, the windows run to the end and pass.
  await h.t.mutation(internal.operations.movedSlotProjections.assertMovedSlotProjections, {
    tenantId: h.tenantId,
    fromDayKey: "2026-09-01",
  });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);

  // Plant a mismatch: the plain cancellation's bucket says moved.
  await h.t.run(async (ctx) => {
    const bucket = (await ctx.db
      .query("operationsMeetingStatsV2")
      .withIndex("by_tenantId_and_dayKey", (q) => q.eq("tenantId", h.tenantId).eq("dayKey", "2026-11-04"))
      .take(10))
      .find((row) => row.meetingStatus === "canceled");
    await ctx.db.patch("operationsMeetingStatsV2", bucket!._id, { meetingStatus: "moved" });
  });
  await expect(
    h.t.mutation(internal.operations.movedSlotProjections.assertMovedSlotProjections, { tenantId: h.tenantId }),
  ).rejects.toThrow(
    "Moved slot projection mismatch on 2026-11-04: meetings give 0 moved and 1 canceled, buckets hold 1 moved and 0 canceled",
  );
});
