import { vi } from "vitest";
import { ATTENDANCE_NOW, showRateFixture } from "./showRateFixtures";

export type AttendanceStorage = "completed" | "held" | "mixed";
export const attendanceStorageModes = ["completed", "held", "mixed"] as const;

/** Exercise readers before, during and after the attendance backfill. */
export async function heldAttendanceFixture(storage: AttendanceStorage) {
  return showRateFixture(ATTENDANCE_NOW, storage);
}

/** A real booking with its lifecycle, aggregates, projections and refs. */
export async function attendanceActionFixture() {
  const { bookingHarness, bookingPayload } = await import("./bookingHarness");
  const { internal } = await import("../convex/_generated/api");
  vi.useFakeTimers();
  vi.setSystemTime(ATTENDANCE_NOW);
  const harness = await bookingHarness({ transactionLimits: true });
  const payload = bookingPayload("attendance-action");
  await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: harness.tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: "2026-10-01T09:00:00Z", payload }),
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.setSystemTime(ATTENDANCE_NOW);
  const meeting = await harness.t.run((ctx) => ctx.db.query("meetings").unique());
  if (!meeting) throw new Error("Missing attendance booking");
  return { ...harness, meeting };
}
