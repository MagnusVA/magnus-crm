import { vi } from "vitest";
import { bookingHarness, qualifiedLifecycle } from "./bookingHarness";
import { insertMeetingAggregate } from "../convex/reporting/writeHooks";
import { recordBookingAttribution } from "../convex/lib/attribution/dealAttributions";

export const ATTENDANCE_NOW = Date.parse("2026-10-22T18:00:00Z");

/** Mixed attendance across finished, current and upcoming business days. */
export async function showRateFixture(
  now = ATTENDANCE_NOW,
  storage: "completed" | "held" | "mixed" = "completed",
) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const harness = await bookingHarness({ transactionLimits: true });
  const { t, tenantId } = harness;
  const fixture = await t.run(async (ctx) => {
    const closer = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
      .unique();
    if (!closer) throw new Error("Missing fixture closer");
    const teamId = await ctx.db.insert("attributionTeams", {
      tenantId,
      slug: "attendance",
      displayName: "Attendance",
      utmSource: "attendance",
      normalizedUtmSource: "attendance",
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    });
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      ...qualifiedLifecycle(0),
      status: "active",
      firstSeenAt: 0,
      updatedAt: 0,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      stage: "booked",
      outcome: "open",
      source: "calendly",
      assignedCloserId: closer._id,
      createdAt: 0,
      updatedAt: 0,
    });
    const specs = [
      ["held-one", "completed", "2026-10-21T12:00:00Z"],
      ["held-two", "completed", "2026-10-22T12:00:00Z"],
      ["missed", "no_show", "2026-10-22T13:00:00Z"],
      ["canceled", "canceled", "2026-10-22T14:00:00Z"],
      ["yesterday-unrecorded", "scheduled", "2026-10-21T14:00:00Z"],
      ["end-boundary", "scheduled", "2026-10-22T17:30:00Z"],
      ["in-progress", "scheduled", "2026-10-22T17:45:00Z"],
      ["upcoming", "scheduled", "2026-10-22T19:00:00Z"],
      ["next-utc-day-finished", "scheduled", "2026-10-23T01:00:00Z"],
      ["next-business-day", "scheduled", "2026-10-23T07:00:00Z"],
    ] as const;
    for (const [index, [key, legacyStatus, at]] of specs.entries()) {
      const status = legacyStatus === "completed" &&
        (storage === "held" || (storage === "mixed" && index === 0))
        ? "held" : legacyStatus;
      const completedAt = legacyStatus === "completed" ? Date.parse(at) + 60_000 : undefined;
      const meetingId = await ctx.db.insert("meetings", {
        tenantId,
        opportunityId,
        assignedCloserId: closer._id,
        calendlyEventUri: `https://api.calendly.com/scheduled_events/${key}`,
        calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${key}/invitees/test`,
        scheduledAt: Date.parse(at),
        durationMinutes: 30,
        status,
        completedAt,
        heldMarkedAt: status === "held" ? completedAt : undefined,
        callClassification: "new",
        createdAt: 0,
      });
      const meeting = await insertMeetingAggregate(ctx, meetingId);
      await recordBookingAttribution(ctx, { meeting, credit: { teamId } });
    }
    return { closerId: closer._id, teamId };
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.setSystemTime(now);
  return { ...harness, ...fixture };
}
