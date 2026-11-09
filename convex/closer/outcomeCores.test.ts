import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  book,
  enrollmentHarness,
  twoPrograms,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";
import { storeProofFile } from "../../tests/proofFixtures";
import { WEB } from "../lib/outcomeCores";
import { checkCallbackTaskAllowed, createCallbackTask } from "./followUpMutations";
import { checkMeetingLossAllowed, recordMeetingLoss } from "./meetingActions";
import { checkNoShowAllowed, recordNoShow } from "./noShowActions";
import { checkMeetingPaymentAllowed, recordMeetingPayment } from "./payments";
import {
  checkTaskLossAllowed,
  checkTaskPaymentAllowed,
  recordTaskLoss,
  recordTaskPayment,
} from "./reminderOutcomes";
import { dumpTables, writtenRows } from "../../tests/writeDump";

// The six outcome mutations split into a guard and a core
// (docs/plans/closer-assistant.md §6.3). These snapshots were taken on the
// handlers before the split: each web path must write the same rows and
// events after it.

afterEach(() => vi.useRealTimers());

const CALL_LOGGED = Date.parse("2026-10-01T12:40:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function bookedDeal(harness: EnrollmentHarness) {
  const { programA } = await twoPrograms(harness);
  const deal = await book(harness, "parity");
  vi.setSystemTime(new Date(CALL_LOGGED));
  return { programId: programA, ...deal };
}

async function pendingReminder(
  harness: EnrollmentHarness,
  deal: { opportunityId: Id<"opportunities">; leadId: Id<"leads"> },
) {
  return await harness.t.run((ctx) =>
    ctx.db.insert("followUps", {
      tenantId: harness.tenantId,
      opportunityId: deal.opportunityId,
      leadId: deal.leadId,
      closerId: harness.closerId,
      type: "manual_reminder",
      contactMethod: "call",
      reminderScheduledAt: CALL_LOGGED - 60_000,
      reason: "closer_initiated",
      status: "pending",
      createdAt: CALL_LOGGED - DAY_MS,
    }),
  );
}

/** Runs `write` and returns the rows it added or changed, by table. */
async function writes(harness: EnrollmentHarness, write: () => Promise<unknown>) {
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  const before = await dumpTables(harness.t);
  const result = await write();
  const after = await dumpTables(harness.t);
  return { result, written: writtenRows(before, after) };
}

describe("web paths write what they wrote before the split", () => {
  it("logPayment, as the closer", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const proofFileId = await storeProofFile(harness.t, { contents: "meeting receipt" });
    const { written } = await writes(harness, () =>
      harness.closer.mutation(api.closer.payments.logPayment, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        amount: 1000,
        currency: "USD",
        programId: deal.programId,
        paymentType: "pif",
        proofFileId,
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("logPayment, as an admin", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { written } = await writes(harness, () =>
      harness.admin.mutation(api.closer.payments.logPayment, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        amount: 250.5,
        currency: "EUR",
        programId: deal.programId,
        paymentType: "deposit",
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("logReminderPayment, as the closer", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const followUpId = await pendingReminder(harness, deal);
    const proofFileId = await storeProofFile(harness.t, { contents: "task receipt" });
    const { written } = await writes(harness, () =>
      harness.closer.mutation(api.closer.reminderOutcomes.logReminderPayment, {
        followUpId,
        amount: 400,
        currency: "USD",
        programId: deal.programId,
        paymentType: "split",
        proofFileId,
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("logReminderPayment, as an admin", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const followUpId = await pendingReminder(harness, deal);
    const { written } = await writes(harness, () =>
      harness.admin.mutation(api.closer.reminderOutcomes.logReminderPayment, {
        followUpId,
        amount: 400,
        currency: "USD",
        programId: deal.programId,
        paymentType: "monthly",
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("createManualReminderFollowUpPublic, from the meeting", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { result, written } = await writes(harness, () =>
      harness.closer.mutation(api.closer.followUpMutations.createManualReminderFollowUpPublic, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        contactMethod: "text",
        reminderScheduledAt: CALL_LOGGED + DAY_MS,
        reminderNote: "Send the contract",
      }),
    );
    expect(result).toMatchObject({ followUpId: expect.any(String) });
    expect(written).toMatchSnapshot();
  });

  it("createManualReminderFollowUpPublic, from the deal", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { written } = await writes(harness, () =>
      harness.closer.mutation(api.closer.followUpMutations.createManualReminderFollowUpPublic, {
        opportunityId: deal.opportunityId,
        contactMethod: "call",
        reminderScheduledAt: CALL_LOGGED + 2 * DAY_MS,
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("markNoShow", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { written } = await writes(harness, () =>
      harness.closer.mutation(api.closer.noShowActions.markNoShow, {
        meetingId: deal.meetingId,
        reason: "no_response",
        note: "  Called twice  ",
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("markAsLost, from the meeting", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { written } = await writes(harness, () =>
      harness.closer.mutation(api.closer.meetingActions.markAsLost, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        reason: " Price ",
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("markAsLost, from the deal, with no reason", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { written } = await writes(harness, () =>
      harness.closer.mutation(api.closer.meetingActions.markAsLost, {
        opportunityId: deal.opportunityId,
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("markReminderLost", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const followUpId = await pendingReminder(harness, deal);
    const { written } = await writes(harness, () =>
      harness.closer.mutation(api.closer.reminderOutcomes.markReminderLost, {
        followUpId,
        reason: "Went quiet",
      }),
    );
    expect(written).toMatchSnapshot();
  });
});

// ─── An agent's provenance ────────────────────────────────────────────

const MCP = { via: "mcp", agentClient: "claude-ai" } as const;

async function actors(harness: EnrollmentHarness) {
  return {
    closer: { userId: harness.closerId, tenantId: harness.tenantId, role: "closer" as const },
    admin: { userId: harness.adminId, tenantId: harness.tenantId, role: "tenant_admin" as const },
  };
}

async function eventsOf(harness: EnrollmentHarness, eventType: string) {
  return await harness.t.run(async (ctx) =>
    (await ctx.db.query("domainEvents").order("desc").take(200))
      .filter((event) => event.eventType === eventType)
      .map((event) => ({
        source: event.source,
        actorUserId: event.actorUserId,
        metadata: event.metadata ? (JSON.parse(event.metadata) as Record<string, unknown>) : {},
      })),
  );
}

describe("an agent's write through a core", () => {
  it("tags the meeting payment's event, and only that event", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { closer } = await actors(harness);
    const proofFileId = await storeProofFile(harness.t);
    await harness.t.run((ctx) =>
      recordMeetingPayment(ctx, closer, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        amount: 1000,
        currency: "USD",
        programId: deal.programId,
        paymentType: "pif",
        proofFileId,
      }, MCP),
    );
    const [payment] = await eventsOf(harness, "payment.recorded");
    expect(payment).toMatchObject({
      source: "closer",
      actorUserId: harness.closerId,
      metadata: { via: "mcp", agentClient: "claude-ai", origin: "closer_meeting" },
    });
    const [won] = await eventsOf(harness, "opportunity.stage_changed");
    expect(won.metadata).not.toHaveProperty("via");
  });

  it("tags the task payment's events", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const followUpId = await pendingReminder(harness, deal);
    const { closer } = await actors(harness);
    const proofFileId = await storeProofFile(harness.t);
    await harness.t.run((ctx) =>
      recordTaskPayment(ctx, closer, {
        followUpId,
        amount: 100,
        currency: "USD",
        programId: deal.programId,
        paymentType: "deposit",
        proofFileId,
      }, MCP),
    );
    expect((await eventsOf(harness, "payment.recorded"))[0].metadata).toMatchObject(MCP);
    expect((await eventsOf(harness, "followUp.completed"))[0].metadata).toMatchObject({
      ...MCP,
      outcome: "payment_received",
    });
  });

  it("tags the call-back's event", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { closer } = await actors(harness);
    await harness.t.run((ctx) =>
      createCallbackTask(ctx, closer, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        contactMethod: "call",
        reminderScheduledAt: CALL_LOGGED + DAY_MS,
      }, MCP),
    );
    expect(await eventsOf(harness, "followUp.created")).toEqual([
      { source: "closer", actorUserId: harness.closerId, metadata: { type: "manual_reminder", opportunityId: deal.opportunityId, ...MCP } },
    ]);
  });

  it("tags the no-show's event", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { closer } = await actors(harness);
    await harness.t.run((ctx) =>
      recordNoShow(ctx, closer, { meetingId: deal.meetingId, reason: "no_response" }, MCP),
    );
    expect(await eventsOf(harness, "meeting.no_show")).toEqual([
      { source: "closer", actorUserId: harness.closerId, metadata: { noteProvided: false, ...MCP } },
    ]);
    // A missed meeting's loss comes from a helper, so it isn't tagged.
    expect((await eventsOf(harness, "opportunity.marked_lost"))[0].metadata).not.toHaveProperty("via");
  });

  it("tags the loss event from a meeting", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { closer } = await actors(harness);
    await harness.t.run((ctx) =>
      recordMeetingLoss(ctx, closer, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        reason: "Price was too high",
      }, MCP),
    );
    expect(await eventsOf(harness, "opportunity.marked_lost")).toEqual([
      {
        source: "closer",
        actorUserId: harness.closerId,
        metadata: { ...MCP, fromOutcome: "open", toOutcome: "lost" },
      },
    ]);
  });

  it("tags the loss event and the task's event from a task", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const followUpId = await pendingReminder(harness, deal);
    const { closer } = await actors(harness);
    await harness.t.run((ctx) =>
      recordTaskLoss(ctx, closer, { followUpId, reason: "Went with another coach" }, MCP),
    );
    expect((await eventsOf(harness, "opportunity.marked_lost"))[0].metadata).toMatchObject({
      ...MCP,
      followUpId,
      origin: "reminder",
    });
    expect((await eventsOf(harness, "followUp.completed"))[0].metadata).toMatchObject({
      ...MCP,
      outcome: "lost",
    });
  });

  it("refuses a role the web mutation never admits", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { admin } = await actors(harness);
    await expect(
      harness.t.run((ctx) =>
        recordNoShow(ctx, admin, { meetingId: deal.meetingId, reason: "no_response" }, MCP),
      ),
    ).rejects.toThrow("This action isn't available for your role.");
  });
});

// ─── Checks before the write (decision 17) ────────────────────────────

describe("each core's check", () => {
  it("passes what the core would take, and writes nothing", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const followUpId = await pendingReminder(harness, deal);
    const { closer } = await actors(harness);
    const proofFileId = await storeProofFile(harness.t);
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
    const before = await dumpTables(harness.t);

    const results = await harness.t.run(async (ctx) => ({
      meetingPayment: await checkMeetingPaymentAllowed(ctx, closer, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        amount: 99.5,
        currency: "usd",
        programId: deal.programId,
        paymentType: "pif",
        proofFileId,
      }),
      taskPayment: await checkTaskPaymentAllowed(ctx, closer, {
        followUpId,
        amount: 10,
        currency: "USD",
        programId: deal.programId,
        paymentType: "deposit",
        proofFileId,
      }),
      callback: await checkCallbackTaskAllowed(ctx, closer, {
        opportunityId: deal.opportunityId,
        contactMethod: "call",
        reminderScheduledAt: CALL_LOGGED + DAY_MS,
      }),
      noShow: await checkNoShowAllowed(ctx, closer, { meetingId: deal.meetingId, reason: "other" }),
      meetingLoss: await checkMeetingLossAllowed(ctx, closer, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
      }),
      taskLoss: await checkTaskLossAllowed(ctx, closer, { followUpId }),
    }));

    expect(results).toMatchObject({
      meetingPayment: { ok: true, amountMinor: 9950, currency: "USD", programName: "Program A" },
      taskPayment: { ok: true, followUpId, amountMinor: 1000 },
      callback: { ok: true, start: "move", meetingId: null },
      noShow: { ok: true, meetingId: deal.meetingId },
      meetingLoss: { ok: true, opportunityId: deal.opportunityId },
      taskLoss: { ok: true, followUpId },
    });
    expect(writtenRows(before, await dumpTables(harness.t))).toEqual({});
  });

  it("returns the refusal the core would throw", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { closer } = await actors(harness);
    await harness.t.run((ctx) =>
      recordNoShow(ctx, closer, { meetingId: deal.meetingId, reason: "no_response" }, WEB),
    );

    const refusal = await harness.t.run((ctx) =>
      checkNoShowAllowed(ctx, closer, { meetingId: deal.meetingId, reason: "no_response" }),
    );
    expect(refusal).toEqual({
      ok: false,
      code: "outcome.refused",
      message: "Meeting is not scheduled (current: no_show)",
    });
    await expect(
      harness.t.run((ctx) =>
        recordNoShow(ctx, closer, { meetingId: deal.meetingId, reason: "no_response" }, WEB),
      ),
    ).rejects.toThrow(refusal.ok ? "" : refusal.message);
  });
});
