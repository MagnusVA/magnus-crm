import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

// The split's invitee snapshot is a second copy of contact details, used only
// to decide who was who (docs/plans/polluted-lead-split.md §5.11).
it("deletes every invitee snapshot row and leaves the meeting alone", async () => {
  vi.useFakeTimers();
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  const meetingId = await harness.t.run(async (ctx) => {
    const closer = (await ctx.db.query("users").first())!;
    const leadId = await ctx.db.insert("leads", {
      ...qualifiedLifecycle(0), tenantId: harness.tenantId, status: "active", firstSeenAt: 0, updatedAt: 0,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId: harness.tenantId, leadId, status: "scheduled", source: "calendly", createdAt: 0, updatedAt: 0,
    });
    const meetingId = await ctx.db.insert("meetings", {
      tenantId: harness.tenantId, opportunityId, assignedCloserId: closer._id, calendlyEventUri: "e1",
      calendlyInviteeUri: "i1", scheduledAt: 0, durationMinutes: 30, status: "scheduled", createdAt: 0,
    });
    // As many rows as production holds, so the run spans two batches of 100.
    for (let index = 0; index < 145; index++) {
      await ctx.db.insert("leadSplitInviteeSnapshots", {
        tenantId: harness.tenantId, meetingId, inviteeUri: `https://api.calendly.com/invitees/${index}`, outcome: "ok",
        email: "person@example.com", name: "Person", fetchedAt: 0,
      });
    }
    return meetingId;
  });

  await harness.t.mutation(internal.migrations.run, { fn: "migrations:deleteLeadSplitInviteeSnapshots" });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

  const state = await harness.t.run(async (ctx) => ({
    snapshots: await ctx.db.query("leadSplitInviteeSnapshots").take(10),
    meeting: await ctx.db.get("meetings", meetingId),
  }));
  expect(state.snapshots).toEqual([]);
  expect(state.meeting).not.toBeNull();
});
