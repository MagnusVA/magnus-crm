import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";
import { correctLeadLifecycle, recordMeeting } from "./leadLifecycle";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const FIRST_CALL = "2026-10-01T12:00:00Z";
const SECOND_CALL = "2026-10-03T12:00:00Z";

async function book(harness: Harness, key: string, startTime: string) {
  const base = bookingPayload(key);
  const end = new Date(Date.parse(startTime) + 30 * 60_000).toISOString();
  const payload = { ...base, scheduled_event: { ...base.scheduled_event, start_time: startTime, end_time: end } };
  await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: harness.tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: "2026-09-30T10:00:00Z", payload }),
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
}

// A person with one or two calls marked held, the way a call decision marks one.
async function heldPerson(harness: Harness, calls: string[]) {
  for (const [index, startTime] of calls.entries()) await book(harness, `call_${index}`, startTime);
  return await harness.t.run(async (ctx) => {
    const lead = (await ctx.db.query("leads").first())!;
    const meetings = await ctx.db.query("meetings").take(10);
    expect(meetings).toHaveLength(calls.length);
    for (const meeting of meetings) {
      await ctx.db.patch("meetings", meeting._id, { status: "held", heldMarkedAt: meeting.scheduledAt + 60_000 });
      await recordMeeting(ctx, meeting._id);
    }
    const first = meetings.find((meeting) => meeting.scheduledAt === Date.parse(FIRST_CALL))!;
    return { leadId: lead._id, firstMeetingId: first._id };
  });
}

// What withdrawAutomatedHeld writes before it corrects the lifecycle.
async function withdrawHeld(
  harness: Harness,
  leadId: Id<"leads">,
  meetingId: Id<"meetings">,
  actorUserId?: Id<"users">,
) {
  return await harness.t.run(async (ctx) => {
    await ctx.db.patch("meetings", meetingId, { status: "scheduled", heldMarkedAt: undefined });
    await correctLeadLifecycle(ctx, leadId, "attendance_withdrawn", actorUserId);
    const events = await ctx.db.query("domainEvents").take(200);
    return {
      lead: (await ctx.db.get("leads", leadId))!,
      stageEvents: events.filter((event) =>
        event.eventType === "lead.lifecycle_stage_changed" && event.reason === "attendance_withdrawn"),
    };
  });
}

describe("correctLeadLifecycle for a withdrawn held mark", () => {
  it("takes the person back from Showed when the withdrawn call was their only held call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    const harness = await bookingHarness();
    const { leadId, firstMeetingId } = await heldPerson(harness, [FIRST_CALL]);
    expect((await harness.t.run((ctx) => ctx.db.get("leads", leadId)))?.lifecycleStage).toBe("showed");

    const { lead, stageEvents } = await withdrawHeld(harness, leadId, firstMeetingId);

    expect(lead.lifecycleStage).toBe("booked");
    expect(lead.lifecycleStageEnteredAt?.showed).toBeUndefined();
    expect(stageEvents).toEqual([
      expect.objectContaining({ fromStatus: "showed", toStatus: "booked", source: "system" }),
    ]);
    expect(stageEvents[0].actorUserId).toBeUndefined();
  });

  it("records the admin who withdrew it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    const harness = await bookingHarness();
    const { leadId, firstMeetingId } = await heldPerson(harness, [FIRST_CALL]);
    const adminId = await harness.t.run(async (ctx) =>
      (await ctx.db.query("users").take(10)).find((user) => user.role === "tenant_admin")!._id);

    const { stageEvents } = await withdrawHeld(harness, leadId, firstMeetingId, adminId);

    expect(stageEvents).toEqual([expect.objectContaining({ source: "admin", actorUserId: adminId })]);
  });

  it("keeps Showed when another held call supports it, with that call's time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    const harness = await bookingHarness();
    const { leadId, firstMeetingId } = await heldPerson(harness, [FIRST_CALL, SECOND_CALL]);

    const { lead, stageEvents } = await withdrawHeld(harness, leadId, firstMeetingId);

    expect(lead.lifecycleStage).toBe("showed");
    expect(lead.lifecycleStageEnteredAt?.showed).toBe(Date.parse(SECOND_CALL));
    expect(stageEvents).toEqual([]);
  });
});
