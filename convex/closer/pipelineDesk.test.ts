import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  DAY,
  HOUR,
  MEETING_RANGE,
  T0,
  closerPipelineHarness,
  insertCloserMeeting,
  insertTask,
  seededCloserPipeline,
} from "../../tests/closerPipelineFixtures";
import { insertCloserPayment, insertProgram } from "../../tests/closerPipelineDeskFixtures";
import { nextStepFromTasks, readCloserDeals } from "./pipelineDeals";

// My Pipeline's desk: the month's cash by currency and program, the month's
// wins, and the open deals by program with their next step
// (.impeccable/surfaces/app-workspace-closer-pipeline-page-tsx.md, "Data rules").

const MONTH = { startDate: T0, endDate: T0 + 31 * DAY };

describe("getMonthCash", () => {
  it("sums the closer's cash by currency and by program, never adding or comparing across currencies", async () => {
    const harness = await closerPipelineHarness();
    const { tenantId, closerId, otherCloserId } = harness;
    const programs = await harness.t.run(async (ctx) => {
      const accelerator = await insertProgram(ctx, tenantId, closerId, "Accelerator");
      const elite = await insertProgram(ctx, tenantId, closerId, "Elite Mentorship");
      await ctx.db.patch("tenantPrograms", elite, { defaultCurrency: "hnl" });
      const pay = (programId: Id<"tenantPrograms">, amountMinor: number, extra = {}) =>
        insertCloserPayment(ctx, { tenantId, closerId, programId, amountMinor, ...extra });
      await pay(accelerator, 1_000_000);
      await pay(accelerator, 260_000, { recordedAt: T0 + 3 * DAY });
      // More lempiras than dollars in raw amount, in one payment.
      await pay(accelerator, 4_000_000, { currency: "hnl" });
      await pay(elite, 580_000, { programName: "Elite (old name)" });
      // None of these count: disputed, a deposit, before the month, the
      // other closer's.
      await pay(accelerator, 99_900, { status: "disputed" });
      await pay(accelerator, 50_000, { paymentType: "deposit" });
      await pay(accelerator, 70_000, { recordedAt: T0 - 1 });
      await insertCloserPayment(ctx, {
        tenantId,
        closerId: otherCloserId,
        programId: elite,
        amountMinor: 900_000,
      });
      return { accelerator, elite };
    });

    const cash = await harness.closer.query(api.closer.pipelineDesk.getMonthCash, MONTH);

    // USD has the most payments, so it leads, though HNL's raw amount is
    // larger; HNL keeps its own sum.
    expect(cash.currencies).toEqual([
      { currency: "USD", amountMinor: 1_840_000, paymentCount: 3 },
      { currency: "HNL", amountMinor: 4_000_000, paymentCount: 1 },
    ]);
    expect(cash.paymentCount).toBe(4);
    expect(cash.isPartial).toBe(false);
    const byProgram = new Map(cash.programs.map((program) => [program.programKey, program]));
    expect(byProgram.get(programs.accelerator)).toEqual({
      programKey: programs.accelerator,
      programName: "Accelerator",
      defaultCurrency: null,
      currencies: [
        { currency: "USD", amountMinor: 1_260_000, paymentCount: 2 },
        { currency: "HNL", amountMinor: 4_000_000, paymentCount: 1 },
      ],
      paymentCount: 3,
    });
    // The program's own name, not the one the payment was recorded under.
    expect(byProgram.get(programs.elite)).toMatchObject({
      programName: "Elite Mentorship",
      // The program's own currency, from its settings.
      defaultCurrency: "HNL",
      currencies: [{ currency: "USD", amountMinor: 580_000, paymentCount: 1 }],
    });
  });

  it("says nothing was paid in a month with no payments", async () => {
    const harness = await closerPipelineHarness();
    const cash = await harness.closer.query(api.closer.pipelineDesk.getMonthCash, MONTH);
    expect(cash).toEqual({ currencies: [], programs: [], paymentCount: 0, isPartial: false });
  });

  it("refuses a range that ends before it starts", async () => {
    const harness = await closerPipelineHarness();
    await expect(
      harness.closer.query(api.closer.pipelineDesk.getMonthCash, {
        startDate: MONTH.endDate,
        endDate: MONTH.startDate,
      }),
    ).rejects.toThrow("startDate must be earlier than endDate");
  });
});

describe("getMonthWins", () => {
  it("counts the wins and the decided deals behind the month's calls, wins by program", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const programId = await harness.t.run(async (ctx) => {
      const id = await insertProgram(ctx, harness.tenantId, harness.closerId, "Accelerator");
      await ctx.db.patch("opportunities", seed.deals.won, { soldProgramId: id });
      return id;
    });

    const wins = await harness.closer.query(api.closer.pipelineDesk.getMonthWins, MEETING_RANGE);

    // As Today's win rate: the person's loss is decided, the no-show's and
    // the cancellation's losses aren't.
    expect(wins).toEqual({
      won: 1,
      decided: 2,
      programs: [{ programKey: programId, won: 1 }],
      isPartial: false,
    });
  });
});

describe("getOpenDeals", () => {
  it("groups the open deals by program sold, else first booked, else none", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { deals } = seed;
    const programs = await harness.t.run(async (ctx) => {
      const { tenantId, closerId } = harness;
      const accelerator = await insertProgram(ctx, tenantId, closerId, "Accelerator");
      const elite = await insertProgram(ctx, tenantId, closerId, "Elite Mentorship");
      await ctx.db.patch("opportunities", deals.booked, {
        firstBookingProgramId: accelerator,
        firstBookingProgramName: "Accelerator (as booked)",
      });
      // Sold beats first booked.
      await ctx.db.patch("opportunities", deals.sideDeal, {
        firstBookingProgramId: accelerator,
        soldProgramId: elite,
        soldProgramName: "Elite Mentorship",
      });
      await ctx.db.patch("opportunities", deals.won, { soldProgramId: accelerator });
      await ctx.db.patch("opportunities", deals.lostByCloser, { firstBookingProgramId: elite });
      return { accelerator, elite };
    });

    const desk = await harness.closer.query(api.closer.pipelineDesk.getOpenDeals, {});

    const programOf = new Map(desk.deals.map((deal) => [deal.opportunityId, deal.programKey]));
    expect(programOf).toEqual(
      new Map([
        [deals.booked, programs.accelerator],
        [deals.sideDeal, programs.elite],
        [deals.linkSent, "none"],
        [deals.reminder, "none"],
        [deals.bareFollowUp, "none"],
      ]),
    );
    expect(new Map(desk.deals.map((deal) => [deal.opportunityId, deal.position]))).toEqual(
      new Map([
        [deals.booked, "booked"],
        [deals.sideDeal, "call_held"],
        [deals.linkSent, "follow_up"],
        [deals.reminder, "follow_up"],
        [deals.bareFollowUp, "follow_up"],
      ]),
    );
    // Open and closed by program; the missed meetings' losses are closed and
    // have no program. The other closer's loss isn't counted.
    expect(new Set(desk.programs)).toEqual(
      new Set([
        { programKey: programs.accelerator, programName: "Accelerator", open: 1, closed: 1 },
        { programKey: programs.elite, programName: "Elite Mentorship", open: 1, closed: 1 },
        { programKey: "none", programName: null, open: 3, closed: 2 },
      ]),
    );
    expect(desk.deals[0]).toMatchObject({ personName: "deal-person@example.com" });
    expect([desk.isPartial, desk.isClosedPartial]).toEqual([false, false]);
  });

  it("gives each open deal its next call and its open task side by side", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { deals } = seed;
    await harness.t.run(async (ctx) => {
      // A call ahead, with a task beside it: both come back; the client shows the call.
      await ctx.db.patch("opportunities", deals.booked, { nextMeetingAt: T0 + 6 * DAY });
      await insertTask(ctx, {
        opportunityId: deals.booked,
        type: "manual_reminder",
        reason: "closer_initiated",
        status: "pending",
        reminderScheduledAt: T0 + DAY,
      });
      // A call that has passed with no result, and a scheduling link waiting:
      // the link still comes back, so the client can show it instead.
      const missedCall = await insertCloserMeeting(ctx, {
        tenantId: harness.tenantId,
        opportunityId: deals.sideDeal,
        closerId: harness.closerId,
        status: "scheduled",
        scheduledAt: T0 - 30 * DAY,
      });
      await ctx.db.patch("opportunities", deals.sideDeal, {
        nextMeetingAt: T0 - 30 * DAY,
        nextMeetingId: missedCall,
      });
      await insertTask(ctx, {
        opportunityId: deals.sideDeal,
        type: "scheduling_link",
        reason: "closer_initiated",
        status: "pending",
      });
      // The system's stale-deal nudge isn't a task.
      await insertTask(ctx, {
        opportunityId: deals.bareFollowUp,
        type: "manual_reminder",
        reason: "stale_opportunity_nudge",
        status: "pending",
        reminderScheduledAt: T0 + HOUR,
      });
    });

    const desk = await harness.closer.query(api.closer.pipelineDesk.getOpenDeals, {});
    const steps = new Map(desk.deals.map((deal) => [deal.opportunityId, deal.nextStep]));

    expect(steps.get(deals.booked)).toEqual({
      callAt: T0 + 6 * DAY,
      task: { kind: "task", method: "call", dueAt: T0 + DAY },
    });
    expect(steps.get(deals.sideDeal)).toEqual({
      callAt: T0 - 30 * DAY,
      task: { kind: "link", reschedule: false, sentAt: T0 },
    });
    // The soonest pending call-back, ahead of the reschedule link beside it.
    expect(steps.get(deals.linkSent)).toEqual({
      callAt: null,
      task: { kind: "task", method: "call", dueAt: T0 + 4 * DAY },
    });
    // The done reminder and the later one don't count.
    expect(steps.get(deals.reminder)).toEqual({
      callAt: null,
      task: { kind: "task", method: "call", dueAt: T0 + 3 * DAY },
    });
    expect(steps.get(deals.bareFollowUp)).toEqual({ callAt: null, task: null });
    // The passed call's meeting comes back, so its outcome can be recorded from the row.
    const meetingOf = new Map(desk.deals.map((deal) => [deal.opportunityId, deal.nextMeetingId]));
    expect(meetingOf.get(deals.sideDeal)).toEqual(expect.any(String));
    expect(meetingOf.get(deals.bareFollowUp)).toBeNull();
  });

  it("refuses an admin on every desk query", async () => {
    const { harness } = await seededCloserPipeline();
    await expect(harness.admin.query(api.closer.pipelineDesk.getOpenDeals, {})).rejects.toThrow();
    await expect(harness.admin.query(api.closer.pipelineDesk.getMonthCash, MONTH)).rejects.toThrow();
    await expect(harness.admin.query(api.closer.pipelineDesk.getMonthWins, MONTH)).rejects.toThrow();
  });

  it("shows another closer none of the closer's deals", async () => {
    const { harness } = await seededCloserPipeline();
    const other = harness.t.withIdentity({ subject: "user_closer_other", org_id: "org_test" });
    const desk = await other.query(api.closer.pipelineDesk.getOpenDeals, {});
    expect(desk.deals).toEqual([]);
    // Their one deal is closed, with no program.
    expect(desk.programs).toEqual([{ programKey: "none", programName: null, open: 0, closed: 1 }]);
  });
});

describe("nextStepFromTasks", () => {
  const task = (fields: Record<string, unknown>) =>
    ({
      status: "pending",
      type: "manual_reminder",
      reason: "closer_initiated",
      createdAt: T0,
      ...fields,
    }) as unknown as Parameters<typeof nextStepFromTasks>[0][number];

  it("takes the soonest task, a text-back when it says text, before any link", () => {
    expect(
      nextStepFromTasks([
        task({ type: "scheduling_link", reason: "no_show_follow_up" }),
        task({ reminderScheduledAt: T0 + 2 * DAY }),
        task({ reminderScheduledAt: T0 + DAY, contactMethod: "text" }),
        task({}),
      ]),
    ).toEqual({ kind: "task", method: "text", dueAt: T0 + DAY });
  });

  it("takes a reschedule link before an ordinary one, else the newest", () => {
    expect(
      nextStepFromTasks([
        task({ type: "scheduling_link", createdAt: T0 + DAY }),
        task({ type: "scheduling_link", reason: "no_show_follow_up", createdAt: T0 }),
      ]),
    ).toEqual({ kind: "link", reschedule: true, sentAt: T0 });
    expect(
      nextStepFromTasks([
        task({ type: "scheduling_link", createdAt: T0 }),
        task({ type: "scheduling_link", createdAt: T0 + DAY }),
      ]),
    ).toEqual({ kind: "link", reschedule: false, sentAt: T0 + DAY });
  });

  it("has no step with no pending task", () => {
    expect(nextStepFromTasks([])).toBeNull();
    expect(nextStepFromTasks([task({ status: "completed", reminderScheduledAt: T0 })])).toBeNull();
  });
});

describe("readCloserDeals", () => {
  it("reads the closer's newest deals and says when it stopped at its bound", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const capped = await harness.t.run((ctx) =>
      readCloserDeals(ctx, harness.tenantId, harness.closerId, 3),
    );
    expect(capped.deals.map((deal) => deal._id)).toEqual([
      seed.deals.noShow,
      seed.deals.lostByCloser,
      seed.deals.won,
    ]);
    expect(capped.capped).toBe(true);

    const whole = await harness.t.run((ctx) => readCloserDeals(ctx, harness.tenantId, harness.closerId));
    expect([whole.deals.length, whole.capped]).toEqual([9, false]);
  });
});
