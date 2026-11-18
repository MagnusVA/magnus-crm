import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import { FIXTURE_NOW, insertProviderMeeting, paymentConfirmationApi, paymentConfirmationFixture, seedReadablePaymentRecording } from "../../tests/providerPaymentFixtures";

const { recordAttendanceOnly } = paymentConfirmationApi.closer.attendanceOnly;
const RECORDED_AT = FIXTURE_NOW - 2 * 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function setup(scheduledAt: number) {
  const f = await paymentConfirmationFixture();
  const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  const meetingId = await f.t.run((ctx) => insertProviderMeeting(ctx, { ...f, opportunityId: f.dealId, scheduledAt }));
  await invariant();
  await f.t.run((ctx) => seedProviderWin(ctx, {
    ...f, opportunityId: f.dealId, approverId: f.adminId, recordedAt: RECORDED_AT,
  }));
  await invariant();
  return { ...f, invariant, meetingId };
}

describe("recordAttendanceOnly", () => {
  it.each(["held", "no_show"] as const)("records %s after a provider win without changing the financial result", async (attendance) => {
    const f = await setup(FIXTURE_NOW - 60_000);
    const args = { meetingId: f.meetingId, attendance };
    await f.t.run((ctx) => seedReadablePaymentRecording(ctx, f));
    await f.invariant();
    const before = await f.t.run((ctx) => ctx.db.get("opportunities", f.dealId));
    const actor = attendance === "held" ? f.owner : f.closer;
    expect(await actor.mutation(recordAttendanceOnly, args)).toEqual({ ok: true, alreadyApplied: false, alreadyRecorded: false });
    await f.invariant();
    const snapshot = await f.t.run(async (ctx) => ({
      meeting: await ctx.db.get("meetings", f.meetingId),
      deal: await ctx.db.get("opportunities", f.dealId),
      secondOpinions: await ctx.db.query("secondOpinions").take(2),
      tasks: await ctx.db.query("followUps").take(2),
      events: await ctx.db.query("domainEvents").take(20),
    }));
    expect(snapshot.meeting?.status).toBe(attendance);
    expect(snapshot.meeting?.attendanceOwedSince).toBeUndefined();
    expect(attendance === "held" ? snapshot.meeting?.heldMarkedAt : snapshot.meeting?.noShowMarkedAt).toBe(FIXTURE_NOW);
    expect(snapshot.deal).toMatchObject({
      stage: "closed", outcome: "won", paymentReceivedAt: RECORDED_AT, soldProgramId: f.programId,
      assignedCloserId: f.closerId, updatedAt: before?.updatedAt, humanResultRevision: 1,
    });
    expect(snapshot.deal?.lostAt).toBeUndefined();
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.secondOpinions).toEqual([]);
    expect(snapshot.events.filter((event) => event.eventType === "meeting.no_show")).toHaveLength(attendance === "held" ? 0 : 1);
    expect(await actor.mutation(recordAttendanceOnly, args)).toEqual({ ok: true, alreadyApplied: true, alreadyRecorded: true });
    await f.invariant();
    expect(await actor.mutation(recordAttendanceOnly, { ...args, attendance: attendance === "held" ? "no_show" : "held" }))
      .toEqual({ ok: false, code: "attendance_not_owed" });
    await f.invariant();
  });

  it("refuses a future meeting, another closer, and an ordinary scheduled meeting", async () => {
    const f = await setup(FIXTURE_NOW + 1);
    const args = { meetingId: f.meetingId, attendance: "held" as const };
    expect(await f.admin.mutation(recordAttendanceOnly, args)).toEqual({ ok: false, code: "meeting_not_started" });
    await f.invariant();
    await f.t.run((ctx) => ctx.db.insert("users", {
      tenantId: f.tenantId, workosUserId: "user_other", email: "other@example.com", role: "closer", isActive: true,
    }));
    const other = f.t.withIdentity({ subject: "user_other", org_id: "org_test" });
    await expect(other.mutation(recordAttendanceOnly, args)).rejects.toThrow("another closer");
    await f.invariant();

    const ordinary = await paymentConfirmationFixture();
    const meetingId = await ordinary.t.run((ctx) => insertProviderMeeting(ctx, {
      ...ordinary, opportunityId: ordinary.dealId, scheduledAt: FIXTURE_NOW - 60_000,
    }));
    expect(await ordinary.closer.mutation(recordAttendanceOnly, { ...args, meetingId }))
      .toEqual({ ok: false, code: "attendance_not_owed" });
    await assertPaymentInvariants(ordinary.t, { tenantId: ordinary.tenantId });
  });
});
