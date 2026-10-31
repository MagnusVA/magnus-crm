import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  guardDealIn,
  guardHarness,
  readGuardDeal,
  type GuardHarness,
  type GuardState,
} from "../../tests/dealGuardFixtures";

// The person page sets a deal's next step from the deal itself: a deal at
// Follow-up whose tasks all closed gets a new task and stays at Follow-up
// (`resolveFollowUpStart`), and an admin cancels a deal's open task
// (`adminCancelTask`). The person payload says which deals take a step.

const followUpNoTask: GuardState = {
  label: "follow_up_scheduled with no task",
  status: "follow_up_scheduled",
  source: "calendly",
};
const followUpWithReminder: GuardState = { ...followUpNoTask, task: "reminder" };
const won: GuardState = { label: "payment_received", status: "payment_received", source: "calendly" };

const HOUR_MS = 60 * 60 * 1000;

async function pendingTasks(harness: GuardHarness, opportunityId: Id<"opportunities">) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) =>
        q.eq("opportunityId", opportunityId).eq("status", "pending"),
      )
      .take(10),
  );
}

async function dealEvents(harness: GuardHarness, opportunityId: Id<"opportunities">) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", harness.tenantId).eq("entityType", "opportunity").eq("entityId", opportunityId),
      )
      .take(10),
  );
}

describe("a next step on a deal at Follow-up with no open task", () => {
  it("adds a call-back and keeps the deal at Follow-up without a stage event", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpNoTask);

    await harness.closer.mutation(api.closer.followUpMutations.createManualReminderFollowUpPublic, {
      opportunityId,
      contactMethod: "call",
      reminderScheduledAt: Date.now() + HOUR_MS,
    });

    const tasks = await pendingTasks(harness, opportunityId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ type: "manual_reminder", contactMethod: "call", createdSource: "closer" });
    const deal = await readGuardDeal(harness, opportunityId);
    expect({ stage: deal.stage, outcome: deal.outcome }).toEqual({ stage: "follow_up", outcome: "open" });
    expect(await dealEvents(harness, opportunityId)).toEqual([]);
  });

  it("refuses a second step while the first is open", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpNoTask);
    await harness.closer.mutation(api.closer.followUpMutations.createSchedulingLinkFollowUp, {
      opportunityId,
    });

    await expect(
      harness.closer.mutation(api.closer.followUpMutations.createManualReminderFollowUpPublic, {
        opportunityId,
        contactMethod: "text",
        reminderScheduledAt: Date.now() + HOUR_MS,
      }),
    ).rejects.toThrow(/Cannot schedule follow-up/);
    expect(await pendingTasks(harness, opportunityId)).toHaveLength(1);
  });

  it("refuses a step set from a call: the call's outcome only moves a deal waiting for it", async () => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, followUpNoTask, {
      meeting: "scheduled",
    });

    await expect(
      harness.closer.mutation(api.closer.followUpMutations.createSchedulingLinkFollowUp, {
        opportunityId,
        meetingId: meetingId!,
      }),
    ).rejects.toThrow(/Cannot schedule follow-up/);
    expect(await pendingTasks(harness, opportunityId)).toEqual([]);
  });

  it("lets an admin set it for the deal's closer", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpNoTask);

    await harness.admin.mutation(api.admin.meetingActions.adminCreateManualReminder, {
      opportunityId,
      contactMethod: "call",
      reminderScheduledAt: Date.now() + HOUR_MS,
    });

    const tasks = await pendingTasks(harness, opportunityId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ closerId: harness.closerId, createdSource: "admin" });
    expect((await readGuardDeal(harness, opportunityId)).stage).toBe("follow_up");
  });
});

describe("adminCancelTask", () => {
  it("expires the open task and leaves the deal open at Follow-up", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithReminder);
    const [task] = await pendingTasks(harness, opportunityId);

    await harness.admin.mutation(api.admin.dealActions.adminCancelTask, { followUpId: task._id });

    const after = await harness.t.run((ctx) => ctx.db.get("followUps", task._id));
    expect(after!.status).toBe("expired");
    const deal = await readGuardDeal(harness, opportunityId);
    expect({ stage: deal.stage, outcome: deal.outcome }).toEqual({ stage: "follow_up", outcome: "open" });
    expect(await dealEvents(harness, opportunityId)).toEqual([]);
  });

  it("is admin-only", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithReminder);
    const [task] = await pendingTasks(harness, opportunityId);

    await expect(
      harness.closer.mutation(api.admin.dealActions.adminCancelTask, { followUpId: task._id }),
    ).rejects.toThrow();
    expect((await pendingTasks(harness, opportunityId))).toHaveLength(1);
  });

  it("refuses a task on a closed deal", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, { ...won, task: "reminder" });
    const [task] = await pendingTasks(harness, opportunityId);

    await expect(
      harness.admin.mutation(api.admin.dealActions.adminCancelTask, { followUpId: task._id }),
    ).rejects.toThrow(/open deal/);
  });
});

describe("the person page's next step per deal", () => {
  async function dealOnPage(
    harness: GuardHarness,
    viewer: "closer" | "admin",
    opportunityId: Id<"opportunities">,
  ) {
    const { leadId } = await readGuardDeal(harness, opportunityId);
    const detail = await harness[viewer].query(api.leadCustomers.detail.getEntityDetail, { leadId });
    if (detail?.kind !== "detail") throw new Error("no detail");
    return detail.opportunities.find((item) => item.opportunity._id === opportunityId)!;
  }

  it("offers a step on the closer's deal at Follow-up with no task", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpNoTask);

    const deal = await dealOnPage(harness, "closer", opportunityId);
    expect(deal.nextStep).toEqual({ callAt: null, task: null, taskId: null, canSet: true });
  });

  it("names the open task and offers no step beside it", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithReminder);
    const [task] = await pendingTasks(harness, opportunityId);

    const deal = await dealOnPage(harness, "admin", opportunityId);
    expect(deal.nextStep).toMatchObject({
      task: { kind: "task", method: "call" },
      taskId: task._id,
      canSet: false,
    });
  });

  it("gives a closed deal no next step", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, won);

    expect((await dealOnPage(harness, "closer", opportunityId)).nextStep).toBeNull();
  });

  it("offers no step on another closer's deal", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpNoTask);
    const otherCloserId = await harness.t.run((ctx) =>
      ctx.db.insert("users", {
        tenantId: harness.tenantId,
        workosUserId: "user_other_closer",
        email: "other@example.com",
        role: "closer",
        isActive: true,
      }),
    );
    await harness.t.run((ctx) => ctx.db.patch("opportunities", opportunityId, { assignedCloserId: otherCloserId }));

    expect((await dealOnPage(harness, "closer", opportunityId)).nextStep?.canSet).toBe(false);
  });
});
