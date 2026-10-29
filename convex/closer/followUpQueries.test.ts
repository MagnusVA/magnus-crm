import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import {
  DAY,
  insertCloserDeal,
  insertTask,
  seededCloserPipeline,
  T0,
} from "../../tests/closerPipelineFixtures";

// The Today page's tasks: pending reminders soonest first, and the pending
// scheduling links that wait on the person to book.

describe("getCloserTasks", () => {
  it("returns the closer's pending reminders soonest first and pending scheduling links", async () => {
    const { harness, seed } = await seededCloserPipeline();
    // Another closer's pending reminder stays theirs.
    await harness.t.run(async (ctx) => {
      const othersDeal = await insertCloserDeal(ctx, {
        tenantId: harness.tenantId, closerId: harness.otherCloserId, status: "follow_up_scheduled", createdAt: T0,
      });
      await insertTask(ctx, {
        opportunityId: othersDeal, type: "manual_reminder", reason: "closer_initiated",
        status: "pending", reminderScheduledAt: T0 + DAY,
      });
    });

    const tasks = await harness.closer.query(api.closer.followUpQueries.getCloserTasks, {});

    expect(tasks.isPartial).toBe(false);
    // The completed reminder isn't listed.
    expect(tasks.reminders.map((task) => task.reminderScheduledAt)).toEqual([
      T0 + 3 * DAY,
      T0 + 4 * DAY,
      T0 + 5 * DAY,
    ]);
    expect(tasks.reminders.map((task) => task.opportunityId)).toEqual([
      seed.deals.reminder,
      seed.deals.linkSent,
      seed.deals.reminder,
    ]);
    expect(tasks.schedulingLinks.map((task) => task.opportunityId).sort()).toEqual(
      [seed.deals.linkSent, seed.deals.reminder].sort(),
    );
  });

  it("gives each task its person and its deal's position and program", async () => {
    const { harness, seed } = await seededCloserPipeline();
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("opportunities", seed.deals.linkSent, { firstBookingProgramName: "Accelerator 90" });
    });

    const tasks = await harness.closer.query(api.closer.followUpQueries.getCloserTasks, {});
    const rescheduleLink = tasks.schedulingLinks.find((task) => task.opportunityId === seed.deals.linkSent);

    expect(rescheduleLink).toMatchObject({
      type: "scheduling_link",
      reason: "no_show_follow_up",
      schedulingLinkUrl: "https://calendly.com/closer/follow-up",
      dealPosition: "follow_up",
      programName: "Accelerator 90",
      reminderScheduledAt: null,
    });
    expect(typeof rescheduleLink?.leadName).toBe("string");
  });

  it("refuses anyone but a closer", async () => {
    const { harness } = await seededCloserPipeline();
    await expect(harness.admin.query(api.closer.followUpQueries.getCloserTasks, {})).rejects.toThrow();
  });
});
