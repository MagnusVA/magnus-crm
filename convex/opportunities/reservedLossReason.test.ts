import { afterEach, describe, expect, it, vi } from "vitest";
import {
  guardDealIn,
  guardHarness,
  insertGuardTask,
  readGuardDeal,
  type GuardHarness,
  type GuardState,
} from "../../tests/dealGuardFixtures";
import { insertCloserMeeting } from "../../tests/closerPipelineFixtures";
import { insertDeal } from "../../tests/dealStageFixtures";
import { adminFixture } from "../../tests/mcpAdminFixtures";
import { callTool } from "../../tests/mcpHarness";
import { mcpToolsFixture } from "../../tests/mcpToolsFixtures";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Target = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  followUpId?: Id<"followUps">;
};
type Writer = {
  name: string;
  state: GuardState;
  meeting?: "scheduled";
  write: (h: GuardHarness, target: Target, reason: string) => Promise<unknown>;
};

const booked = { label: "booked", status: "scheduled", source: "calendly" } as const;
const reminder = { label: "follow-up", status: "follow_up_scheduled", source: "calendly", task: "reminder" } as const;
const writers: Writer[] = [
  {
    name: "closer meeting",
    state: booked,
    meeting: "scheduled",
    write: (h, { opportunityId, meetingId }, reason) =>
      h.closer.mutation(api.closer.meetingActions.markAsLost, { opportunityId, meetingId, reason }),
  },
  {
    name: "admin meeting",
    state: booked,
    meeting: "scheduled",
    write: (h, { opportunityId, meetingId }, reason) =>
      h.admin.mutation(api.admin.meetingActions.adminMarkAsLost, { opportunityId, meetingId, reason }),
  },
  {
    name: "reminder",
    state: reminder,
    write: (h, { followUpId }, reason) =>
      h.closer.mutation(api.closer.reminderOutcomes.markReminderLost, { followUpId: followUpId!, reason }),
  },
  {
    name: "link task",
    state: { ...reminder, task: "scheduling_link" },
    write: (h, { followUpId }, reason) =>
      h.closer.mutation(api.closer.linkTaskOutcomes.markLinkTaskLost, { followUpId: followUpId!, reason }),
  },
  {
    name: "side deal",
    state: { ...booked, source: "side_deal" },
    write: (h, { opportunityId }, reason) =>
      h.closer.mutation(api.sideDeals.markLost.markLost, { opportunityId, reason }),
  },
  {
    name: "reminder give up",
    state: reminder,
    write: (h, { followUpId }, note) =>
      h.closer.mutation(api.closer.reminderOutcomes.markReminderNoResponse, {
        followUpId: followUpId!,
        nextStep: "give_up",
        note,
      }),
  },
];

async function setup(writer: Writer) {
  const h = await guardHarness();
  const { opportunityId, meetingId } = await guardDealIn(
    h,
    { ...writer.state, task: undefined },
    { meeting: writer.meeting },
  );
  const task = writer.state.task;
  const followUpId = task
    ? await h.t.run((ctx) => insertGuardTask(ctx, opportunityId, task))
    : undefined;
  return { h, target: { opportunityId, meetingId: meetingId ?? undefined, followUpId } };
}

function stateOf(h: GuardHarness, { opportunityId, meetingId, followUpId }: Target) {
  return h.t.run(async (ctx) => ({
    deal: await ctx.db.get("opportunities", opportunityId),
    meeting: meetingId ? await ctx.db.get("meetings", meetingId) : null,
    followUp: followUpId ? await ctx.db.get("followUps", followUpId) : null,
    events: await ctx.db.query("domainEvents").take(20),
  }));
}

describe.each(writers)("$name loss reasons", (writer) => {
  it("rejects all reserved spellings without changing the deal, meeting, task or events", async () => {
    const { h, target } = await setup(writer);
    const before = await stateOf(h, target);
    for (const reason of ["payment_excluded", "PAYMENT_EXCLUDED", " Payment_Excluded "]) {
      await expect(writer.write(h, target, reason)).rejects.toMatchObject({
        data: { code: "deal.reserved_loss_reason" },
      });
      expect(await stateOf(h, target)).toEqual(before);
    }
  });

  it.each([" Budget changed ", ""])(`accepts %j`, async (reason) => {
    const { h, target } = await setup(writer);
    await writer.write(h, target, reason);
    const deal = await readGuardDeal(h, target.opportunityId);
    expect(deal.outcome).toBe("lost");
    expect(deal.lostReason).toBe(
      reason.trim() || (writer.name === "reminder give up" ? "No response to outreach" : undefined),
    );
  });
});

describe("MCP loss tools", () => {
  it("returns the reserved reason refusal in the closer's meeting and task tools", async () => {
    const f = await mcpToolsFixture();
    for (const target of [{ meetingId: f.meetingId }, { taskId: f.taskId }]) {
      const result = await callTool(f.t, f.token, f.sessionId, "magnus_mark_lost", {
        ...target,
        reason: " Payment_Excluded ",
        confirm: false,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("That reason is reserved.");
    }
  });

  it("returns the reserved reason refusal when an admin previews a loss", async () => {
    const f = await adminFixture({ writeFamilies: ["results"] });
    const meetingId = await f.t.run(async (ctx) => {
      const opportunityId = await insertDeal(ctx, {
        tenantId: f.tenantId,
        status: "scheduled",
        fields: { assignedCloserId: f.closerId },
      });
      return await insertCloserMeeting(ctx, {
        tenantId: f.tenantId,
        opportunityId,
        closerId: f.closerId,
        scheduledAt: Date.now() - 60 * 60 * 1000,
        status: "scheduled",
      });
    });
    const result = await callTool(f.t, f.adminToken, f.adminSession, "magnus_record_result", {
      meetingId,
      result: { kind: "lost", category: "other", reason: " Payment_Excluded " },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("That reason is reserved.");
  });
});
