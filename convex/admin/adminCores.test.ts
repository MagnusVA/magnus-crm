import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { book, enrollmentHarness, type EnrollmentHarness } from "../../tests/enrollmentFixtures";
import { dumpTables, writtenRows } from "../../tests/writeDump";
import { WEB, type CoreActor, type Provenance } from "../lib/outcomeCores";
import type { MutationCtx } from "../_generated/server";
import { adminCancelTaskCore, checkAdminCancelTaskAllowed } from "./dealActions";
import {
  adminCancelPendingFollowUpCore,
  adminCreateFollowUpCore,
  adminCreateManualReminderCore,
  adminCreateRescheduleLinkCore,
  adminMarkLostCore,
  adminMarkNoShowCore,
  checkAdminCancelPendingFollowUpAllowed,
  checkAdminManualReminderAllowed,
  checkAdminMarkLostAllowed,
  checkAdminMarkNoShowAllowed,
  checkAdminRescheduleLinkAllowed,
} from "./meetingActions";

// The admin meeting and task actions split into a guard and a core (admin
// assistant, commit 8). These snapshots were taken on the handlers before the
// split: each web path must write the same rows and events after it, and
// refuse with the same message.

afterEach(() => vi.useRealTimers());

const CALL_LOGGED = Date.parse("2026-10-01T12:40:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function bookedDeal(harness: EnrollmentHarness) {
  const deal = await book(harness, "admin-parity");
  await harness.t.run((ctx) =>
    ctx.db.patch("users", harness.closerId, {
      personalEventTypeUri: "https://calendly.com/closer/sales-call",
    }),
  );
  vi.setSystemTime(new Date(CALL_LOGGED));
  return deal;
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
      reminderScheduledAt: CALL_LOGGED + DAY_MS,
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
  it("adminMarkAsLost, from the meeting", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { written } = await writes(harness, () =>
      harness.admin.mutation(api.admin.meetingActions.adminMarkAsLost, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        reason: "  Went with a competitor  ",
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("adminMarkAsLost, from the deal, with no reason", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { written } = await writes(harness, () =>
      harness.admin.mutation(api.admin.meetingActions.adminMarkAsLost, {
        opportunityId: deal.opportunityId,
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("adminMarkNoShow", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { written } = await writes(harness, () =>
      harness.admin.mutation(api.admin.meetingActions.adminMarkNoShow, {
        meetingId: deal.meetingId,
        reason: "late_cancel",
        note: "  Texted at noon  ",
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("adminCreateManualReminder, from the meeting", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { written, result } = await writes(harness, () =>
      harness.admin.mutation(api.admin.meetingActions.adminCreateManualReminder, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        contactMethod: "text",
        reminderScheduledAt: CALL_LOGGED + 2 * DAY_MS,
        reminderNote: "Ask about the budget",
      }),
    );
    expect({ result, written }).toMatchSnapshot();
  });

  it("adminCreateFollowUp, from the meeting", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { written, result } = await writes(harness, () =>
      harness.admin.mutation(api.admin.meetingActions.adminCreateFollowUp, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
      }),
    );
    expect({ result, written }).toMatchSnapshot();
  });

  it("adminCancelPendingFollowUp", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const followUpId = await pendingReminder(harness, deal);
    const { written } = await writes(harness, () =>
      harness.admin.mutation(api.admin.meetingActions.adminCancelPendingFollowUp, {
        followUpId,
      }),
    );
    expect(written).toMatchSnapshot();
  });

  it("adminCreateRescheduleLink, after a no-show", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    await harness.admin.mutation(api.admin.meetingActions.adminMarkNoShow, {
      meetingId: deal.meetingId,
      reason: "no_response",
    });
    const { written, result } = await writes(harness, () =>
      harness.admin.mutation(api.admin.meetingActions.adminCreateRescheduleLink, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
      }),
    );
    expect({ result, written }).toMatchSnapshot();
  });

  it("adminCancelTask, on a deal at Follow-up", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const { followUpId } = await harness.admin.mutation(
      api.admin.meetingActions.adminCreateManualReminder,
      {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        contactMethod: "call",
        reminderScheduledAt: CALL_LOGGED + DAY_MS,
      },
    );
    const { written } = await writes(harness, () =>
      harness.admin.mutation(api.admin.dealActions.adminCancelTask, { followUpId }),
    );
    expect(written).toMatchSnapshot();
  });

  it("refuses with the same messages", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const refusals: Record<string, string> = {};
    const refusal = async (name: string, write: () => Promise<unknown>) => {
      try {
        await write();
        refusals[name] = "allowed";
      } catch (error) {
        refusals[name] = (error as Error).message;
      }
    };
    await refusal("closer calls an admin action", () =>
      harness.closer.mutation(api.admin.meetingActions.adminMarkAsLost, {
        opportunityId: deal.opportunityId,
      }),
    );
    await refusal("reschedule link on a booked deal", () =>
      harness.admin.mutation(api.admin.meetingActions.adminCreateRescheduleLink, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
      }),
    );
    await refusal("reminder in the past", () =>
      harness.admin.mutation(api.admin.meetingActions.adminCreateManualReminder, {
        opportunityId: deal.opportunityId,
        contactMethod: "call",
        reminderScheduledAt: CALL_LOGGED - DAY_MS,
      }),
    );
    await harness.admin.mutation(api.admin.meetingActions.adminMarkNoShow, {
      meetingId: deal.meetingId,
      reason: "no_response",
    });
    await refusal("no-show twice", () =>
      harness.admin.mutation(api.admin.meetingActions.adminMarkNoShow, {
        meetingId: deal.meetingId,
        reason: "no_response",
      }),
    );
    await refusal("lost after a no-show", () =>
      harness.admin.mutation(api.admin.meetingActions.adminMarkAsLost, {
        opportunityId: deal.opportunityId,
      }),
    );
    const followUpId = await pendingReminder(harness, deal);
    await refusal("cancel a task on a closed deal", () =>
      harness.admin.mutation(api.admin.dealActions.adminCancelTask, { followUpId }),
    );
    await refusal("cancel a pending follow-up on a closed deal", () =>
      harness.admin.mutation(api.admin.meetingActions.adminCancelPendingFollowUp, {
        followUpId,
      }),
    );
    expect(refusals).toMatchSnapshot();
  });
});

const MCP = { via: "mcp", agentClient: "claude-ai" } as const;

type Deal = Awaited<ReturnType<typeof bookedDeal>>;

function adminActor(harness: EnrollmentHarness): CoreActor {
  return { userId: harness.adminId, tenantId: harness.tenantId, role: "tenant_admin" };
}

/** The rows with the agent's tag taken out of event metadata. */
function untag(written: unknown): unknown {
  if (Array.isArray(written)) return written.map(untag);
  if (!written || typeof written !== "object") return written;
  const entries = Object.entries(written).filter(([key]) => key !== "via" && key !== "agentClient");
  return Object.fromEntries(entries.map(([key, value]) => [key, untag(value)]));
}

/** Tagged event types in the rows a write added. */
function taggedEvents(written: ReturnType<typeof writtenRows>) {
  return (written.domainEvents?.added ?? [])
    .filter((row) => JSON.stringify(row.metadata ?? {}).includes('"via":"mcp"'))
    .map((row) => row.eventType);
}

type Case = {
  name: string;
  setup?: (harness: EnrollmentHarness, deal: Deal) => Promise<Record<string, unknown>>;
  web: (harness: EnrollmentHarness, deal: Deal, extra: Record<string, unknown>) => Promise<unknown>;
  core: (
    ctx: MutationCtx,
    actor: CoreActor,
    deal: Deal,
    extra: Record<string, unknown>,
    provenance: Provenance,
  ) => Promise<unknown>;
  tagged: string[];
};

const noShow = async (harness: EnrollmentHarness, deal: Deal) => {
  await harness.admin.mutation(api.admin.meetingActions.adminMarkNoShow, {
    meetingId: deal.meetingId,
    reason: "no_response",
  });
  return {};
};

const cases: Case[] = [
  {
    name: "adminMarkLostCore",
    web: (h, d) =>
      h.admin.mutation(api.admin.meetingActions.adminMarkAsLost, {
        opportunityId: d.opportunityId,
        meetingId: d.meetingId,
        reason: "Budget",
      }),
    core: (ctx, a, d, _e, p) =>
      adminMarkLostCore(ctx, a, { opportunityId: d.opportunityId, meetingId: d.meetingId, reason: "Budget" }, p),
    tagged: ["opportunity.marked_lost"],
  },
  {
    name: "adminMarkNoShowCore",
    web: (h, d) =>
      h.admin.mutation(api.admin.meetingActions.adminMarkNoShow, {
        meetingId: d.meetingId,
        reason: "late_cancel",
        note: "Texted",
      }),
    core: (ctx, a, d, _e, p) =>
      adminMarkNoShowCore(ctx, a, { meetingId: d.meetingId, reason: "late_cancel", note: "Texted" }, p),
    tagged: ["meeting.no_show"],
  },
  {
    name: "adminCreateManualReminderCore",
    web: (h, d) =>
      h.admin.mutation(api.admin.meetingActions.adminCreateManualReminder, {
        opportunityId: d.opportunityId,
        meetingId: d.meetingId,
        contactMethod: "call",
        reminderScheduledAt: CALL_LOGGED + DAY_MS,
      }),
    core: (ctx, a, d, _e, p) =>
      adminCreateManualReminderCore(
        ctx,
        a,
        {
          opportunityId: d.opportunityId,
          meetingId: d.meetingId,
          contactMethod: "call",
          reminderScheduledAt: CALL_LOGGED + DAY_MS,
        },
        p,
      ),
    tagged: ["followUp.created"],
  },
  {
    name: "adminCreateFollowUpCore",
    web: (h, d) =>
      h.admin.mutation(api.admin.meetingActions.adminCreateFollowUp, {
        opportunityId: d.opportunityId,
        meetingId: d.meetingId,
      }),
    core: (ctx, a, d, _e, p) =>
      adminCreateFollowUpCore(ctx, a, { opportunityId: d.opportunityId, meetingId: d.meetingId }, p),
    tagged: ["followUp.created"],
  },
  {
    name: "adminCreateRescheduleLinkCore",
    setup: noShow,
    web: (h, d) =>
      h.admin.mutation(api.admin.meetingActions.adminCreateRescheduleLink, {
        opportunityId: d.opportunityId,
        meetingId: d.meetingId,
      }),
    core: (ctx, a, d, _e, p) =>
      adminCreateRescheduleLinkCore(ctx, a, { opportunityId: d.opportunityId, meetingId: d.meetingId }, p),
    tagged: ["followUp.created"],
  },
  {
    name: "adminCancelTaskCore",
    setup: async (h, d) => ({
      followUpId: (
        await h.admin.mutation(api.admin.meetingActions.adminCreateManualReminder, {
          opportunityId: d.opportunityId,
          meetingId: d.meetingId,
          contactMethod: "call",
          reminderScheduledAt: CALL_LOGGED + DAY_MS,
        })
      ).followUpId,
    }),
    web: (h, _d, e) =>
      h.admin.mutation(api.admin.dealActions.adminCancelTask, { followUpId: e.followUpId as Id<"followUps"> }),
    core: (ctx, a, _d, e, p) => adminCancelTaskCore(ctx, a, { followUpId: e.followUpId as Id<"followUps"> }, p),
    tagged: ["followUp.expired"],
  },
  {
    name: "adminCancelPendingFollowUpCore",
    setup: async (h, d) => ({ followUpId: await pendingReminder(h, d) }),
    web: (h, _d, e) =>
      h.admin.mutation(api.admin.meetingActions.adminCancelPendingFollowUp, {
        followUpId: e.followUpId as Id<"followUps">,
      }),
    core: (ctx, a, _d, e, p) =>
      adminCancelPendingFollowUpCore(ctx, a, { followUpId: e.followUpId as Id<"followUps"> }, p),
    tagged: ["followUp.expired"],
  },
];

describe("an agent's write through a core", () => {
  it.each(cases)("$name writes the web's rows and tags its event", async (c) => {
    const web = await enrollmentHarness();
    const webDeal = await bookedDeal(web);
    const webExtra = (await c.setup?.(web, webDeal)) ?? {};
    const webWrites = await writes(web, () => c.web(web, webDeal, webExtra));

    const mcp = await enrollmentHarness();
    const mcpDeal = await bookedDeal(mcp);
    const mcpExtra = (await c.setup?.(mcp, mcpDeal)) ?? {};
    const mcpWrites = await writes(mcp, () =>
      mcp.t.run((ctx) => c.core(ctx, adminActor(mcp), mcpDeal, mcpExtra, MCP)),
    );
    expect(untag(mcpWrites.written)).toEqual(webWrites.written);
    expect(untag(mcpWrites.result)).toEqual(webWrites.result ?? null);
    expect(taggedEvents(mcpWrites.written)).toEqual(c.tagged);
    if (c.tagged.length) {
      const event = mcpWrites.written.domainEvents!.added.find((row) => row.eventType === c.tagged[0])!;
      expect(event.metadata).toMatchObject({ via: "mcp", agentClient: "claude-ai" });
    }
  });

  it("refuses a closer actor", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const closer: CoreActor = { userId: harness.closerId, tenantId: harness.tenantId, role: "closer" };
    await expect(
      harness.t.run((ctx) => adminMarkLostCore(ctx, closer, { opportunityId: deal.opportunityId }, WEB)),
    ).rejects.toThrow("This action isn't available for your role.");
  });
});

describe("each core's check", () => {
  it("passes what the core would take, refuses what it would refuse, and writes nothing", async () => {
    const harness = await enrollmentHarness();
    const deal = await bookedDeal(harness);
    const actor = adminActor(harness);
    const followUpId = await pendingReminder(harness, deal);
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
    const before = await dumpTables(harness.t);
    const results = await harness.t.run(async (ctx) => ({
      lost: await checkAdminMarkLostAllowed(ctx, actor, { opportunityId: deal.opportunityId, meetingId: deal.meetingId }),
      noShow: await checkAdminMarkNoShowAllowed(ctx, actor, { meetingId: deal.meetingId, reason: "no_response" }),
      reminder: await checkAdminManualReminderAllowed(ctx, actor, {
        opportunityId: deal.opportunityId,
        contactMethod: "call",
        reminderScheduledAt: CALL_LOGGED - 1,
      }),
      link: await checkAdminRescheduleLinkAllowed(ctx, actor, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
      }),
      cancelPending: await checkAdminCancelPendingFollowUpAllowed(ctx, actor, { followUpId }),
      cancelTask: await checkAdminCancelTaskAllowed(ctx, actor, { followUpId }),
    }));
    expect(writtenRows(before, await dumpTables(harness.t))).toEqual({});
    expect(results.lost).toMatchObject({ ok: true, opportunityId: deal.opportunityId, meetingId: deal.meetingId });
    expect(results.noShow).toMatchObject({ ok: true, meetingId: deal.meetingId });
    expect(results.reminder).toEqual({
      ok: false,
      code: "outcome.refused",
      message: "Reminder must be scheduled in the future",
    });
    expect(results.link).toEqual({
      ok: false,
      code: "outcome.refused",
      message: "Can only create reschedule links for no-show opportunities",
    });
    expect(results.cancelPending).toMatchObject({ ok: true, followUpId });
    expect(results.cancelTask).toMatchObject({ ok: true, followUpId });
  });
});
