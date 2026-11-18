import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import {
  automationCallFixture, FIXTURE_NOW, insertProviderDeal, insertProviderMeeting, seedAutomationSample, seedCallDecision,
} from "../../tests/providerPaymentFixtures";
import { api } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { adminCreateManualReminderCore, adminMarkLostCore } from "../admin/meetingActions";
import { createCallbackTask } from "../closer/followUpMutations";
import { recordMeetingLoss } from "../closer/meetingActions";
import { recordMeeting } from "../lib/leadLifecycle";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";
import { patchOpportunityLifecycle, transitionOpportunity } from "../lib/opportunityActivity";
import { WEB, type CoreActor } from "../lib/outcomeCores";
import { recordCallReceipt } from "./callReceipts";
import { noteHumanResult } from "./humanResult";
import { undoCallTaskCore } from "./taskCorrections";

type Fixture = Awaited<ReturnType<typeof automationCallFixture>>;
type DecisionId = Id<"resultAutomationDecisions">;
const change = makeFunctionReference<"mutation", {
  decisionId: DecisionId; contactMethod: "call" | "text"; reminderScheduledAt: number;
}>("automation/taskCorrections:changeNextStep");
const withdraw = makeFunctionReference<"mutation", { decisionId: DecisionId }>(
  "automation/taskCorrections:callDidNotHappen",
);
const callbackTime = FIXTURE_NOW + 86_400_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function invariants(f: Fixture) {
  await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  await assertAutomationInvariants(f.t, { tenantId: f.tenantId });
}

function actorFor(f: Fixture, role: "closer" | "tenant_admin"): CoreActor {
  return { tenantId: f.tenantId, role, userId: role === "closer" ? f.closerId : f.adminId };
}

function seedDecision(f: Fixture, ctx: MutationCtx, kind: "call_back" | "refusal_loss") {
  return seedCallDecision(ctx, {
    tenantId: f.tenantId, kind, opportunityId: f.opportunityId, leadId: f.personId,
    meetingId: f.meetingId, closerId: f.closerId, runId: f.runId, recordingId: f.recordingId,
  });
}

async function applyTask(f: Fixture, writer: "closer" | "tenant_admin" | "system" = "closer") {
  return await f.t.run(async (ctx) => {
    await recordMeeting(ctx, f.meetingId);
    const latestActivityAt = FIXTURE_NOW - 1;
    await patchOpportunityLifecycle(ctx, f.opportunityId, { latestActivityAt });
    const decisionId = await seedDecision(f, ctx, "call_back");
    const isSystem = writer === "system";
    if (isSystem) {
      const decision = (await ctx.db.get("resultAutomationDecisions", decisionId))!;
      const certificateSampleId = await seedAutomationSample(ctx, {
        tenantId: f.tenantId, kind: "call_back", ruleVersion: decision.ruleVersion,
        status: "certified", target: 1, certifiedAt: FIXTURE_NOW,
      });
      await ctx.db.patch("resultAutomationDecisions", decisionId, { mode: "automatic", certificateSampleId });
    }
    const actor = isSystem ? null : actorFor(f, writer);
    const core = writer === "tenant_admin" ? adminCreateManualReminderCore : createCallbackTask;
    const { followUpId } = await core(ctx, actor, {
      opportunityId: f.opportunityId,
      meetingId: f.meetingId,
      contactMethod: "call",
      reminderScheduledAt: callbackTime,
      reminderNote: "This text must never reach the saved automation task.",
    }, WEB, { decisionId, system: isSystem, task: { purpose: "call_back" } });
    const receipt = {
      decisionId, appliedVia: isSystem ? "automatic" as const : "meeting_confirm" as const,
      approverUserId: actor?.userId, followUpId, now: FIXTURE_NOW,
      callBefore: { position: "booked" as const, meetingId: f.meetingId, meetingStatus: "scheduled" as const, latestActivityAt },
    };
    expect(await recordCallReceipt(ctx, receipt)).toBe(decisionId);
    expect(await recordCallReceipt(ctx, receipt)).toBe(decisionId);
    if (actor) await noteHumanResult(ctx, f.opportunityId, actor, { consumeDecisionId: decisionId });
    return { decisionId, followUpId, latestActivityAt };
  });
}

describe("C2 core options", () => {
  it("rejects the server option on all four public mutations", async () => {
    const f = await automationCallFixture();
    const args = { opportunityId: f.opportunityId, meetingId: f.meetingId, automation: { system: true } };
    const task = { ...args, contactMethod: "call" as const, reminderScheduledAt: callbackTime };
    // Runtime validators must reject extra input, even if a client bypasses TypeScript.
    await expect(f.closer.mutation(api.closer.followUpMutations.createManualReminderFollowUpPublic, task))
      .rejects.toThrow(/automation/);
    await expect(f.admin.mutation(api.admin.meetingActions.adminCreateManualReminder, task))
      .rejects.toThrow(/automation/);
    await expect(f.closer.mutation(api.closer.meetingActions.markAsLost, args)).rejects.toThrow(/automation/);
    await expect(f.admin.mutation(api.admin.meetingActions.adminMarkAsLost, args)).rejects.toThrow(/automation/);
    await invariants(f);
  });

  it.each(["closer", "tenant_admin"] as const)("%s rejects typed refusal codes and accepts the linked proposal", async (role) => {
    const f = await automationCallFixture();
    const actor = actorFor(f, role);
    const args = { opportunityId: f.opportunityId, meetingId: f.meetingId };
    for (const reason of ["call_refusal", "Call_Refusal", "  CALL_REFUSAL  "]) {
      const result = role === "closer"
        ? f.closer.mutation(api.closer.meetingActions.markAsLost, { ...args, reason })
        : f.admin.mutation(api.admin.meetingActions.adminMarkAsLost, { ...args, reason });
      await expect(result).rejects.toThrow(/reserved/);
      await invariants(f);
    }
    await f.t.run(async (ctx) => {
      const decisionId = await seedDecision(f, ctx, "refusal_loss");
      const core = role === "closer" ? recordMeetingLoss : adminMarkLostCore;
      await core(ctx, actor, { ...args, reason: "call_refusal" }, WEB, { decisionId, refusal: true });
      await recordCallReceipt(ctx, {
        decisionId, appliedVia: "meeting_confirm", approverUserId: actor.userId, now: FIXTURE_NOW,
        callBefore: { position: "booked", meetingId: f.meetingId, meetingStatus: "scheduled", latestActivityAt: FIXTURE_NOW - 1 },
      });
      await noteHumanResult(ctx, f.opportunityId, actor, { consumeDecisionId: decisionId });
      expect(await ctx.db.get("opportunities", f.opportunityId)).toMatchObject({
        outcome: "lost", lostReason: "call_refusal", lostByUserId: actor.userId,
      });
      expect(await ctx.db.query("secondOpinions").take(2)).toHaveLength(role === "closer" ? 1 : 0);
    });
    await invariants(f);
  });

  it.each(["closer", "tenant_admin", "system"] as const)("%s records the purpose and held mark, with the right Second opinion behavior", async (writer) => {
    const f = await automationCallFixture();
    const { followUpId, decisionId, latestActivityAt } = await applyTask(f, writer);
    await f.t.run(async (ctx) => {
      const task = (await ctx.db.get("followUps", followUpId))!;
      expect(task).toMatchObject({
        purpose: "call_back", status: "pending", reason: "call_insights", automationDecisionId: decisionId,
        createdSource: writer === "tenant_admin" ? "admin" : writer,
      });
      expect(task.reminderNote).toBeUndefined();
      expect(await ctx.db.get("meetings", f.meetingId)).toMatchObject({
        status: "held", attendanceSource: "call_insights", attendanceDecisionId: decisionId,
      });
      const checks = await ctx.db.query("secondOpinions").take(2);
      expect(checks).toHaveLength(writer === "closer" ? 1 : 0);
      if (writer === "closer") expect(checks[0].meetingId).toBe(f.meetingId);
      if (writer === "system") {
        expect(task.createdByUserId).toBeUndefined();
        expect(await ctx.db.get("opportunities", f.opportunityId)).toMatchObject({ latestActivityAt });
      }
    });
    await invariants(f);
  });

  it("refuses due-now callback creation even with the server option", async () => {
    const f = await automationCallFixture();
    await expect(f.t.run(async (ctx) => {
      const decisionId = await seedDecision(f, ctx, "call_back");
      await createCallbackTask(ctx, actorFor(f, "closer"), {
        opportunityId: f.opportunityId, meetingId: f.meetingId, contactMethod: "call", reminderScheduledAt: FIXTURE_NOW,
      }, WEB, { decisionId, allowDueNow: true });
    })).rejects.toThrow(/must be in the future/);
    await invariants(f);
  });
});

describe("C2 call task corrections", () => {
  it.each([-1000, 0, 3600_000])("replaces the next step (%i ms from now) while leaving attendance and provenance", async (delay) => {
    const f = await automationCallFixture();
    const { decisionId, followUpId } = await applyTask(f);
    await invariants(f);
    const result = await f.closer.mutation(change, {
      decisionId, contactMethod: "text", reminderScheduledAt: FIXTURE_NOW + delay,
    });
    expect(result).toMatchObject({ ok: true });
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get("followUps", followUpId)).toMatchObject({ status: "expired" });
      expect(await ctx.db.get("followUps", result.followUpId)).toMatchObject({
        status: "pending", contactMethod: "text", reminderScheduledAt: FIXTURE_NOW + delay,
      });
      expect(await ctx.db.get("meetings", f.meetingId)).toMatchObject({ status: "held", attendanceDecisionId: decisionId });
      expect(await ctx.db.get("resultAutomationDecisions", decisionId)).toMatchObject({ state: "corrected" });
      expect(await ctx.db.get("opportunities", f.opportunityId)).toMatchObject({ humanResultRevision: 2, stage: "follow_up" });
    });
    await invariants(f);
  });

  it.each([false, true])("withdraws a held mark and re-derives Showed (another held call: %s)", async (hasOtherHeldCall) => {
    const f = await automationCallFixture();
    if (hasOtherHeldCall) {
      await f.t.run(async (ctx) => {
        const otherDeal = await insertProviderDeal(ctx, { ...f, leadId: f.personId, assignedCloserId: f.closerId });
        const other = await insertProviderMeeting(ctx, {
          ...f, opportunityId: otherDeal, scheduledAt: FIXTURE_NOW - 86_400_000,
        });
        await patchMeetingLifecycle(ctx, other, { status: "held", heldMarkedAt: FIXTURE_NOW - 86_400_000 });
        await transitionOpportunity(ctx, otherDeal, { to: { stage: "follow_up" }, source: "admin", actorUserId: f.adminId });
        await recordMeeting(ctx, other);
      });
    }
    const { decisionId, followUpId, latestActivityAt } = await applyTask(f);
    await invariants(f);
    expect(await f.t.run((ctx) => ctx.db.get("leads", f.personId))).toMatchObject({ lifecycleStage: "showed" });
    await expect(f.closer.mutation(withdraw, { decisionId })).rejects.toThrow();
    vi.setSystemTime(FIXTURE_NOW + 1000);
    expect(await f.admin.mutation(withdraw, { decisionId })).toEqual({ ok: true, alreadyApplied: false });
    await f.t.run(async (ctx) => {
      const meeting = (await ctx.db.get("meetings", f.meetingId))!;
      expect(meeting.status).toBe("scheduled");
      expect(meeting.heldMarkedAt).toBeUndefined();
      expect(meeting.attendanceDecisionId).toBeUndefined();
      expect(meeting.attendanceSource).toBeUndefined();
      expect(await ctx.db.get("opportunities", f.opportunityId)).toMatchObject({ stage: "booked", latestActivityAt });
      expect(await ctx.db.get("leads", f.personId)).toMatchObject({ lifecycleStage: hasOtherHeldCall ? "showed" : "booked" });
      expect(await ctx.db.get("followUps", followUpId)).toMatchObject({ status: "expired" });
      expect(await ctx.db.get("resultAutomationDecisions", decisionId)).toMatchObject({ state: "undone" });
    });
    await invariants(f);
  });

  it("leaves the deal at Follow-up if the deal changed after the held mark", async () => {
    const f = await automationCallFixture();
    const { decisionId } = await applyTask(f);
    await invariants(f);
    vi.setSystemTime(FIXTURE_NOW + 1000);
    await f.t.run((ctx) => patchOpportunityLifecycle(ctx, f.opportunityId, { updatedAt: Date.now() }));
    expect(await f.admin.mutation(withdraw, { decisionId })).toMatchObject({ ok: true });
    expect(await f.t.run((ctx) => ctx.db.get("opportunities", f.opportunityId))).toMatchObject({ stage: "follow_up" });
    await invariants(f);
  });

  it("refuses both corrections once the closer works the task", async () => {
    const f = await automationCallFixture();
    const { decisionId, followUpId } = await applyTask(f);
    await invariants(f);
    await f.closer.mutation(api.closer.followUpMutations.markReminderComplete, { followUpId });
    expect(await f.admin.mutation(withdraw, { decisionId })).toEqual({ ok: false, code: "needs_review" });
    expect(await f.closer.mutation(change, {
      decisionId, contactMethod: "text", reminderScheduledAt: callbackTime,
    })).toEqual({ ok: false, code: "needs_review" });
    await invariants(f);
  });

  it("undoes an untouched automatic task without withdrawing the call when it happened", async () => {
    const f = await automationCallFixture();
    const { decisionId, followUpId } = await applyTask(f, "system");
    await invariants(f);
    expect(await f.t.run((ctx) => undoCallTaskCore(ctx, actorFor(f, "closer"), decisionId, { callHappened: true })))
      .toMatchObject({ ok: true });
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get("meetings", f.meetingId)).toMatchObject({ status: "held", attendanceDecisionId: decisionId });
      expect(await ctx.db.get("followUps", followUpId)).toMatchObject({ status: "expired" });
      expect(await ctx.db.get("resultAutomationDecisions", decisionId)).toMatchObject({ state: "undone" });
    });
    await invariants(f);
  });

  it("names one caller for the held-to-scheduled exception", () => {
    const root = new URL("..", import.meta.url).pathname;
    const files = readdirSync(root, { recursive: true, encoding: "utf-8" })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("_generated/"));
    const calls = files.filter((name) => {
      const source = readFileSync(join(root, name), "utf-8");
      return name !== "lib/statusTransitions.ts" && /\bvalidateAutomationHeldUndone\s*\(|["']automation_held_undone["']/.test(source);
    });
    expect(calls).toEqual(["lib/meetingAttendanceUndo.ts"]);
    const imports = files.filter((name) => /from ["'][^"']*\/meetingAttendanceUndo["']/.test(readFileSync(join(root, name), "utf-8")));
    expect(imports).toEqual(["automation/taskCorrections.ts"]);
  });
});
