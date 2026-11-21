import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { meetingsByStatus } from "../reporting/aggregates";
import { insertMeetingAggregate } from "../reporting/writeHooks";
import { FIXTURE_NOW, FIXTURE_PAID_AT, providerPaymentFixture } from "../../tests/providerPaymentFixtures";
import { assertPaymentInvariants, seedProviderWin, seedUndoToBooked } from "../../tests/paymentInvariants";
import { ATTENDANCE_DEBT_MEETING_LIMIT, clearAttendanceOwed, markAttendanceOwed } from "./attendanceDebt";

const HOUR = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Harness = Awaited<ReturnType<typeof providerPaymentFixture>>;

async function meeting(ctx: MutationCtx, h: Harness, status: "scheduled" | "held", scheduledAt: number, durationMinutes = 30) {
  const id = await ctx.db.insert("meetings", {
    tenantId: h.tenantId, opportunityId: h.dealId!, assignedCloserId: h.closerId,
    calendlyEventUri: `https://api.calendly.com/scheduled_events/${scheduledAt}`,
    calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${scheduledAt}/invitees/x`,
    scheduledAt, durationMinutes, status, createdAt: scheduledAt,
    ...(status === "held" ? { heldMarkedAt: scheduledAt + HOUR } : {}),
  });
  await insertMeetingAggregate(ctx, id);
  return id;
}

async function wonDeal() {
  const h = await providerPaymentFixture({ dealPosition: "booked" });
  const ids = await h.t.run(async (ctx) => {
    const held = await meeting(ctx, h, "held", FIXTURE_PAID_AT - 5 * HOUR);
    const first = await meeting(ctx, h, "scheduled", FIXTURE_NOW + 2 * HOUR, 45);
    const second = await meeting(ctx, h, "scheduled", FIXTURE_NOW + 26 * HOUR);
    const paymentRecordId = await seedProviderWin(ctx, {
      tenantId: h.tenantId, opportunityId: h.dealId!, providerPaymentId: h.providerPaymentId, programId: h.programId,
      closerId: h.closerId, approverId: h.adminId, recordedAt: FIXTURE_PAID_AT,
    });
    return { held, first, second, paymentRecordId };
  });
  return { ...h, ...ids, dealId: h.dealId! };
}

// t.run returns Convex values, so an absent marker comes back as null.
const owed = (h: Harness, ids: Id<"meetings">[]) =>
  h.t.run(async (ctx) => await Promise.all(ids.map(async (id) => (await ctx.db.get("meetings", id))!.attendanceOwedSince ?? null)));

describe("markAttendanceOwed", () => {
  it("marks every scheduled meeting of the won deal at its end, and leaves attendance and clocks alone", async () => {
    const h = await wonDeal();
    // seedProviderWin marks, as the apply core will; clear first to watch one call.
    await h.t.run((ctx) => clearAttendanceOwed(ctx, h.dealId));
    const before = await h.t.run(async (ctx) => ({
      deal: await ctx.db.get("opportunities", h.dealId),
      held: await ctx.db.get("meetings", h.held),
      scheduledCount: await meetingsByStatus.count(ctx, { namespace: h.tenantId }),
    }));

    const { meetingIds } = await h.t.run((ctx) => markAttendanceOwed(ctx, h.dealId));

    expect(meetingIds.sort()).toEqual([h.first, h.second].sort());
    expect(await owed(h, [h.first, h.second, h.held])).toEqual([
      FIXTURE_NOW + 2 * HOUR + 45 * 60_000,
      FIXTURE_NOW + 26 * HOUR + 30 * 60_000,
      null,
    ]);
    const after = await h.t.run(async (ctx) => ({
      deal: await ctx.db.get("opportunities", h.dealId),
      held: await ctx.db.get("meetings", h.held),
      scheduledCount: await meetingsByStatus.count(ctx, { namespace: h.tenantId }),
    }));
    expect(after).toEqual(before);
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });
  });

  it("skips the meeting whose result is being recorded", async () => {
    const h = await wonDeal();
    await h.t.run((ctx) => clearAttendanceOwed(ctx, h.dealId));
    const { meetingIds } = await h.t.run((ctx) => markAttendanceOwed(ctx, h.dealId, { exceptMeetingId: h.first }));
    expect(meetingIds).toEqual([h.second]);
    expect(await owed(h, [h.first, h.second])).toEqual([null, FIXTURE_NOW + 26 * HOUR + 30 * 60_000]);
  });

  it("writes nothing on a retry", async () => {
    const h = await wonDeal();
    expect(await h.t.run((ctx) => markAttendanceOwed(ctx, h.dealId))).toEqual({ meetingIds: [] });
  });

  it("refuses a deal that isn't won", async () => {
    const h = await providerPaymentFixture({ dealPosition: "booked" });
    await expect(h.t.run((ctx) => markAttendanceOwed(ctx, h.dealId!))).rejects.toThrow("isn't won");
  });

  it(`throws past ${ATTENDANCE_DEBT_MEETING_LIMIT} scheduled meetings rather than mark part of them`, async () => {
    const h = await wonDeal();
    await h.t.run(async (ctx) => {
      for (let index = 0; index < ATTENDANCE_DEBT_MEETING_LIMIT - 1; index += 1) {
        await meeting(ctx, h, "scheduled", FIXTURE_NOW + (30 + index) * HOUR);
      }
    });
    await expect(h.t.run((ctx) => markAttendanceOwed(ctx, h.dealId))).rejects.toThrow("more than 20 scheduled meetings");
  });
});

describe("clearAttendanceOwed", () => {
  it("clears the debt when an exclusion takes the deal off won", async () => {
    const h = await wonDeal();
    expect((await owed(h, [h.first, h.second])).every((value) => value !== null)).toBe(true);
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });

    await h.t.run((ctx) => seedUndoToBooked(ctx, {
      paymentRecordId: h.paymentRecordId, approverId: h.adminId, veto: false, now: FIXTURE_NOW,
    }));

    expect(await owed(h, [h.first, h.second, h.held])).toEqual([null, null, null]);
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });
  });
});
