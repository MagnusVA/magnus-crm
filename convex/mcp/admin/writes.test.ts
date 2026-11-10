/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { adminCaller, adminFixture } from "../../../tests/mcpAdminFixtures";
import { callTool, mcpRpc } from "../../../tests/mcpHarness";
import { insertDeal } from "../../../tests/dealStageFixtures";
import { insertCloserMeeting } from "../../../tests/closerPipelineFixtures";
import { insertCloserPayment, insertProgram } from "../../../tests/closerPipelineDeskFixtures";
import { insertBillingPaymentAggregates } from "../../billing/aggregates";
import { insertMeetingAggregate } from "../../reporting/writeHooks";
import type { WriteFamily } from "../families";

/** Prepare, commit and approve (docs/plans/admin-assistant.md §4). */

type Prepared = { commit: { confirmToken: string; action: string; target: { kind: string; id: string; label: string }; summary: string } };
type PlanPrepared = { planId: Id<"mcpConfirmations">; approvalUrl: string; status: string };

async function withMeeting(h: Awaited<ReturnType<typeof adminFixture>>, scheduledAt: number) {
  return await h.t.run(async (ctx) => {
    const dealId = await insertDeal(ctx, { tenantId: h.tenantId, status: "scheduled", fields: { assignedCloserId: h.closerId } });
    const meetingId = await insertCloserMeeting(ctx, {
      tenantId: h.tenantId,
      opportunityId: dealId,
      closerId: h.closerId,
      status: "scheduled",
      scheduledAt,
    });
    await insertMeetingAggregate(ctx, meetingId);
    return { dealId, meetingId };
  });
}

async function fixture(families: WriteFamily[] = ["goals", "results", "payments", "opinions", "repairs"]) {
  const h = await adminFixture({ writeFamilies: families });
  const caller = adminCaller(h.orgId);
  const prepareGoal = (value: number | null) =>
    h.t.mutation(internal.mcp.admin.writes.goals.prepareSetGoal, { caller, kind: "daily_qualifications", value }) as Promise<Prepared>;
  const commit = (c: Prepared["commit"]) => h.t.mutation(internal.mcp.admin.commit.commit, { caller, ...c });
  const goal = () => h.t.run(async (ctx) => (await ctx.db.get("tenants", h.tenantId))?.slackQualificationDailyTeamQuota ?? null);
  return { ...h, caller, prepareGoal, commit, goal };
}

describe("prepare and commit", () => {
  it("changes nothing at prepare, applies at commit, and replays a repeated commit", async () => {
    const h = await fixture();
    const prepared = await h.prepareGoal(12);
    expect(prepared.commit.summary).toBe("Daily qualification goal · no goal → 12");
    expect(await h.goal()).toBeNull();
    const first = await h.commit(prepared.commit);
    expect(first).toMatchObject({ status: "applied" });
    expect(await h.goal()).toBe(12);
    const again = await h.commit(prepared.commit);
    expect(again).toMatchObject({ status: "applied", replay: true });
    const receipt = await h.t.run((ctx) => ctx.db.query("mcpConfirmations").first());
    expect(receipt).toMatchObject({ status: "applied", family: "goals", agentClient: "claude-ai" });
    expect(receipt?.keepUntil).toBeGreaterThan(Date.now() + 300 * 86_400_000);
  });

  it("refuses a commit whose echo was edited", async () => {
    const h = await fixture();
    const prepared = await h.prepareGoal(12);
    await expect(h.commit({ ...prepared.commit, summary: "Daily qualification goal · no goal → 120" })).rejects.toThrow();
    await expect(h.commit({ ...prepared.commit, target: { ...prepared.commit.target, id: "other" } })).rejects.toThrow();
    expect(await h.goal()).toBeNull();
  });

  it("writes nothing when a pinned record changed after the preview", async () => {
    const h = await fixture();
    const prepared = await h.prepareGoal(12);
    await h.t.run((ctx) => ctx.db.patch("tenants", h.tenantId, { slackQualificationDailyTeamQuota: 9 }));
    expect(await h.commit(prepared.commit)).toMatchObject({ status: "stale" });
    expect(await h.goal()).toBe(9);
  });

  it("refuses a commit after the owner switches the family off, and after access changed", async () => {
    const h = await fixture();
    const prepared = await h.prepareGoal(12);
    await h.ownerWeb.mutation(api.mcp.settings.setWriteAccess, { writeRoles: ["tenant_admin"], writeFamilies: ["payments"] });
    expect(await h.commit(prepared.commit)).toMatchObject({ status: "refused" });
    expect(await h.goal()).toBeNull();
    // Switched back on, the old draft stays refused: access changed after it.
    await h.ownerWeb.mutation(api.mcp.settings.setWriteAccess, { writeRoles: ["tenant_admin"], writeFamilies: ["goals"] });
    expect(await h.commit(prepared.commit)).toMatchObject({ status: "refused", replay: true });
    const fresh = await h.prepareGoal(12);
    expect(await h.commit(fresh.commit)).toMatchObject({ status: "applied" });
  });

  it("refuses a commit after the admin is blocked", async () => {
    const h = await fixture();
    const prepared = await h.prepareGoal(12);
    await h.ownerWeb.mutation(api.mcp.settings.setUserBlocked, { userId: h.adminId, blocked: true });
    await expect(h.commit(prepared.commit)).rejects.toThrow();
    expect(await h.goal()).toBeNull();
  });

  it("won't redeem another admin's token", async () => {
    const h = await fixture();
    const prepared = await h.prepareGoal(12);
    const owner = adminCaller(h.orgId, "claude-ai", "user_owner");
    await expect(h.t.mutation(internal.mcp.admin.commit.commit, { caller: owner, ...prepared.commit })).rejects.toThrow();
    expect(await h.goal()).toBeNull();
  });

  it("shows only the switched-on families in tools/list", async () => {
    const h = await fixture(["goals"]);
    const list = await mcpRpc(h.t, h.adminToken, "tools/list", {}, h.adminSession);
    const names = ((list.body?.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
    expect(names).toContain("magnus_set_goal");
    expect(names).toContain("magnus_commit");
    expect(names).not.toContain("magnus_correct_payment");
    expect(names).not.toContain("magnus_record_result");
    const { meetingId } = await withMeeting(h, Date.now() - 3_600_000);
    const refused = await callTool(h.t, h.adminToken, h.adminSession, "magnus_record_result", {
      meetingId,
      result: { kind: "no_show", reason: "no_response" },
    });
    expect(refused.isError || Boolean(refused.response.body?.error)).toBe(true);
    expect(await h.t.run((ctx) => ctx.db.query("mcpConfirmations").take(10))).toHaveLength(0);
    // The same call is prepared once the owner switches results on.
    await h.ownerWeb.mutation(api.mcp.settings.setWriteAccess, { writeRoles: ["tenant_admin"], writeFamilies: ["goals", "results"] });
    const allowed = await callTool(h.t, h.adminToken, h.adminSession, "magnus_record_result", {
      meetingId,
      result: { kind: "no_show", reason: "no_response" },
    });
    expect(allowed.isError).toBe(false);
  });

  it("runs a whole change over /mcp", async () => {
    const h = await fixture(["goals"]);
    const prepared = await callTool(h.t, h.adminToken, h.adminSession, "magnus_set_goal", { kind: "daily_qualifications", value: 7 });
    expect(prepared.isError).toBe(false);
    const commit = (prepared.data as Prepared).commit;
    const done = await callTool(h.t, h.adminToken, h.adminSession, "magnus_commit", commit);
    expect(done.isError).toBe(false);
    expect(await h.goal()).toBe(7);
  });
});

describe("results", () => {
  it("refuses a result before the call starts", async () => {
    const h = await fixture();
    const { meetingId } = await withMeeting(h, Date.now() + 3_600_000);
    await expect(
      h.t.mutation(internal.mcp.admin.writes.results.prepareRecordResult, {
        caller: h.caller,
        meetingId,
        result: { kind: "no_show", reason: "no_response" },
      }),
    ).rejects.toThrow("can be recorded once it has started");
  });

  it("commits a no-show in chat", async () => {
    const h = await fixture();
    const { meetingId } = await withMeeting(h, Date.now() - 3_600_000);
    const prepared = (await h.t.mutation(internal.mcp.admin.writes.results.prepareRecordResult, {
      caller: h.caller,
      meetingId,
      result: { kind: "no_show", reason: "no_response" },
    })) as Prepared;
    expect(await h.commit(prepared.commit)).toMatchObject({ status: "applied" });
    const meeting = await h.t.run((ctx) => ctx.db.get("meetings", meetingId));
    expect(meeting?.status).toBe("no_show");
  });

  it("sends a loss to Magnus for approval, and only an allowed person can approve it", async () => {
    const h = await fixture();
    const { meetingId, dealId } = await withMeeting(h, Date.now() - 3_600_000);
    const plan = (await h.t.mutation(internal.mcp.admin.writes.results.prepareRecordResult, {
      caller: h.caller,
      meetingId,
      result: { kind: "lost", category: "price", reason: "Wants to wait for the bonus" },
    })) as PlanPrepared;
    expect(plan.status).toBe("waiting_for_approval");
    expect(plan.approvalUrl).toContain(`/workspace/assistant/approvals/${plan.planId}`);
    // A closer's session can't open the plan.
    await expect(h.closerWeb.query(api.mcp.approvals.getPlan, { planId: plan.planId })).rejects.toThrow();
    await expect(h.closerWeb.mutation(api.mcp.approvals.approvePlan, { planId: plan.planId })).rejects.toThrow();
    const view = await h.adminWeb.query(api.mcp.approvals.getPlan, { planId: plan.planId });
    expect(view).toMatchObject({ canApprove: true, status: "waiting" });
    expect(await h.adminWeb.mutation(api.mcp.approvals.approvePlan, { planId: plan.planId })).toMatchObject({ status: "applied" });
    const deal = await h.t.run((ctx) => ctx.db.get("opportunities", dealId));
    expect(deal?.outcome).toBe("lost");
    expect(await h.adminWeb.mutation(api.mcp.approvals.approvePlan, { planId: plan.planId })).toMatchObject({ replay: true });
  });

  it("returns an existing call-back instead of preparing a second one", async () => {
    const h = await fixture();
    const { dealId } = await withMeeting(h, Date.now() - 3_600_000);
    const first = (await h.t.mutation(internal.mcp.admin.writes.nextStep.prepareNextStep, {
      caller: h.caller,
      opportunityId: dealId,
      action: { kind: "callback", method: "call", date: "2099-01-05", time: "10:00" },
    })) as Prepared;
    expect(await h.commit(first.commit)).toMatchObject({ status: "applied" });
    const second = await h.t.mutation(internal.mcp.admin.writes.nextStep.prepareNextStep, {
      caller: h.caller,
      opportunityId: dealId,
      action: { kind: "callback", method: "call", date: "2099-01-05", time: "10:00" },
    });
    expect(second).toMatchObject({ alreadyExists: true });
  });
});

describe("daily cap", () => {
  it("refuses changes past the day's cap with a receipt", async () => {
    const h = await fixture();
    // Burn the workspace's window.
    for (let i = 0; i < 150; i++) {
      const p = await h.prepareGoal(i + 1);
      await h.commit(p.commit);
    }
    const p = await h.prepareGoal(999);
    expect(await h.commit(p.commit)).toMatchObject({ status: "refused" });
    expect(await h.goal()).toBe(150);
  }, 60_000);
});

describe("round 1 review fixes", () => {
  it("refuses the owner's approval of a plan whose admin was blocked since, even after an unblock", async () => {
    const h = await fixture();
    const { meetingId } = await withMeeting(h, Date.now() - 3_600_000);
    const plan = (await h.t.mutation(internal.mcp.admin.writes.results.prepareRecordResult, {
      caller: h.caller,
      meetingId,
      result: { kind: "lost", category: "price", reason: "Wants to wait for the bonus" },
    })) as PlanPrepared;
    // Prepared a second earlier, so the block's time is strictly after it.
    await h.t.run(async (ctx) => {
      const row = (await ctx.db.get("mcpConfirmations", plan.planId))!;
      await ctx.db.patch("mcpConfirmations", plan.planId, { createdAt: (row.createdAt ?? Date.now()) - 1000 });
    });
    await h.ownerWeb.mutation(api.mcp.settings.setUserBlocked, { userId: h.adminId, blocked: true });
    await h.ownerWeb.mutation(api.mcp.settings.setUserBlocked, { userId: h.adminId, blocked: false });
    expect(await h.ownerWeb.query(api.mcp.approvals.getPlan, { planId: plan.planId })).toMatchObject({ canApprove: false });
    await expect(h.ownerWeb.mutation(api.mcp.approvals.approvePlan, { planId: plan.planId })).rejects.toThrow("blocked or removed");
  });

  it("writes nothing when a payment's reference code changed after the preview", async () => {
    const h = await fixture();
    const paymentId = await h.t.run(async (ctx) => {
      const programId = await insertProgram(ctx, h.tenantId, h.ownerId, "Coaching");
      const id = await insertCloserPayment(ctx, { tenantId: h.tenantId, closerId: h.closerId, programId, amountMinor: 50000 });
      await ctx.db.patch("paymentRecords", id, { referenceCode: "OLD-1" });
      await insertBillingPaymentAggregates(ctx, (await ctx.db.get("paymentRecords", id))!);
      return id;
    });
    const prepared = (await h.t.mutation(internal.mcp.admin.writes.payments.prepareCorrectPayment, {
      caller: h.caller,
      paymentRecordId: paymentId,
      referenceCode: "NEW-2",
      reason: "Typo in the code",
    })) as Prepared;
    await h.t.run((ctx) => ctx.db.patch("paymentRecords", paymentId, { referenceCode: "WEB-3" }));
    expect(await h.commit(prepared.commit)).toMatchObject({ status: "stale" });
    expect((await h.t.run((ctx) => ctx.db.get("paymentRecords", paymentId)))?.referenceCode).toBe("WEB-3");
  });

  it("refuses a scheduling link at prepare when the closer has no booking page", async () => {
    const h = await fixture();
    const { dealId } = await withMeeting(h, Date.now() - 3_600_000);
    await expect(
      h.t.mutation(internal.mcp.admin.writes.nextStep.prepareNextStep, {
        caller: h.caller,
        opportunityId: dealId,
        action: { kind: "scheduling_link" },
      }),
    ).rejects.toThrow();
    expect(await h.t.run((ctx) => ctx.db.query("mcpConfirmations").take(10))).toHaveLength(0);
  });
});

describe("review bot fixes", () => {
  async function payment(h: Awaited<ReturnType<typeof fixture>>, fields: Record<string, unknown> = {}) {
    return await h.t.run(async (ctx) => {
      const programId = await insertProgram(ctx, h.tenantId, h.ownerId, "Coaching");
      const id = await insertCloserPayment(ctx, { tenantId: h.tenantId, closerId: h.closerId, programId, amountMinor: 50000 });
      if (Object.keys(fields).length) await ctx.db.patch("paymentRecords", id, fields);
      await insertBillingPaymentAggregates(ctx, (await ctx.db.get("paymentRecords", id))!);
      return id;
    });
  }

  it("refuses a correction that matches the payment already", async () => {
    const h = await fixture();
    const paymentRecordId = await payment(h, { referenceCode: "SAME-1" });
    await expect(
      h.t.mutation(internal.mcp.admin.writes.payments.prepareCorrectPayment, {
        caller: h.caller,
        paymentRecordId,
        amount: 500,
        referenceCode: "SAME-1",
        reason: "Double checking it",
      }),
    ).rejects.toThrow("Nothing to correct");
  });

  it("makes the commit stale when the payment turns disputed after the preview", async () => {
    const h = await fixture();
    const paymentRecordId = await payment(h);
    const prepared = (await h.t.mutation(internal.mcp.admin.writes.payments.prepareCorrectPayment, {
      caller: h.caller,
      paymentRecordId,
      amount: 400,
      reason: "Wrong amount logged",
    })) as Prepared;
    await h.t.run((ctx) => ctx.db.patch("paymentRecords", paymentRecordId, { status: "disputed" }));
    expect(await h.commit(prepared.commit)).toMatchObject({ status: "stale" });
  });

  it("gives the core's own reason for a disputed payment", async () => {
    const h = await fixture();
    const paymentRecordId = await payment(h, { status: "disputed" });
    await expect(
      h.t.mutation(internal.mcp.admin.writes.payments.prepareCorrectPayment, {
        caller: h.caller,
        paymentRecordId,
        amount: 400,
        reason: "Wrong amount logged",
      }),
    ).rejects.toThrow("dispute");
  });
});

describe("goal limits", () => {
  it("prepares a goal up to the web's limit of 5000, and refuses above it", async () => {
    const h = await fixture();
    const prepared = await h.prepareGoal(5000);
    expect(prepared.commit.summary).toBe("Daily qualification goal · no goal → 5000");
    await expect(h.prepareGoal(5001)).rejects.toThrow("0 to 5000");
  });
});
