import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { FIXTURE_NOW, providerPaymentFixture, seedAppliedReceipt, seedReadyDecision } from "../../tests/providerPaymentFixtures";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import {
  HUMAN_RESULT_STOP_BATCH,
  RE_EVALUATE_AFTER_HUMAN_RESULT,
  noteHumanResult,
} from "./humanResult";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Harness = Awaited<ReturnType<typeof providerPaymentFixture>>;
type State = Doc<"resultAutomationDecisions">["state"];

let sequence = 0;

/** A decision on the deal in `state`, derived at `revision`. */
async function decision(
  ctx: MutationCtx,
  h: Harness,
  state: State,
  options: { revision?: number; opportunityId?: Id<"opportunities"> } = {},
) {
  sequence += 1;
  const id = await seedReadyDecision(ctx, {
    tenantId: h.tenantId, providerPaymentId: h.providerPaymentId, opportunityId: options.opportunityId ?? h.dealId!,
    leadId: h.personId, humanResultRevision: options.revision ?? 0, createdAt: FIXTURE_NOW + sequence,
  });
  if (state !== "ready") await ctx.db.patch("resultAutomationDecisions", id, { state });
  return id;
}

const states = (h: Harness, ids: Id<"resultAutomationDecisions">[]) => h.t.run(async (ctx) =>
  await Promise.all(ids.map(async (id) => {
    const row = (await ctx.db.get("resultAutomationDecisions", id))!;
    return [row.state, row.stopCode ?? null] as const;
  })));

const actorOf = (h: Harness) => ({ tenantId: h.tenantId, userId: h.closerId });

describe("noteHumanResult", () => {
  it("bumps the deal's revision once per call and leaves every other field", async () => {
    const h = await providerPaymentFixture({ dealPosition: "booked" });
    const before = await h.t.run((ctx) => ctx.db.get("opportunities", h.dealId!));

    const first = await h.t.run((ctx) => noteHumanResult(ctx, h.dealId!, actorOf(h)));
    vi.setSystemTime(FIXTURE_NOW + 60_000);
    const second = await h.t.run((ctx) => noteHumanResult(ctx, h.dealId!, actorOf(h)));

    expect([first, second]).toEqual([{ revision: 1 }, { revision: 2 }]);
    const after = await h.t.run((ctx) => ctx.db.get("opportunities", h.dealId!));
    expect(after).toEqual({ ...before, humanResultRevision: 2 });
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.latestActivityAt).toBe(before?.latestActivityAt);
  });

  it("emits no event", async () => {
    const h = await providerPaymentFixture({ dealPosition: "booked" });
    const count = () => h.t.run(async (ctx) => (await ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_occurredAt", (q) => q.eq("tenantId", h.tenantId)).take(100)).length);
    const before = await count();
    await h.t.run((ctx) => noteHumanResult(ctx, h.dealId!, actorOf(h)));
    expect(await count()).toBe(before);
  });

  it("stops the deal's ready, needs-person and blocked decisions, and nothing else", async () => {
    const h = await providerPaymentFixture({ dealPosition: "booked" });
    const ids = await h.t.run(async (ctx) => {
      const otherDeal = await ctx.db.insert("opportunities", {
        stage: "follow_up", outcome: "open", source: "calendly", tenantId: h.tenantId, leadId: h.personId,
        createdAt: 0, updatedAt: 0,
      });
      return {
        ready: await decision(ctx, h, "ready"),
        needsPerson: await decision(ctx, h, "needs_person"),
        blocked: await decision(ctx, h, "blocked"),
        shadow: await decision(ctx, h, "shadow"),
        applied: await decision(ctx, h, "applied"),
        superseded: await decision(ctx, h, "superseded"),
        otherDeal: await decision(ctx, h, "ready", { opportunityId: otherDeal }),
      };
    });

    await h.t.run((ctx) => noteHumanResult(ctx, h.dealId!, actorOf(h)));

    const order = [ids.ready, ids.needsPerson, ids.blocked, ids.shadow, ids.applied, ids.superseded, ids.otherDeal];
    expect(await states(h, order)).toEqual([
      ["stopped", "human_result"],
      ["stopped", "human_result"],
      ["stopped", "human_result"],
      ["shadow", null],
      ["applied", null],
      ["superseded", null],
      ["ready", null],
    ]);
    const stopped = await h.t.run((ctx) => ctx.db.get("resultAutomationDecisions", ids.ready));
    expect(stopped).toMatchObject({ resolvedAt: FIXTURE_NOW, resolvedByUserId: h.closerId });
  });

  it("spares the decision it consumes, and stamps an applied one with the new revision", async () => {
    const h = await providerPaymentFixture({ dealPosition: "booked" });
    const { consumedReady, other } = await h.t.run(async (ctx) => ({
      consumedReady: await decision(ctx, h, "ready"),
      other: await decision(ctx, h, "needs_person"),
    }));
    await h.t.run((ctx) => noteHumanResult(ctx, h.dealId!, actorOf(h), { consumeDecisionId: consumedReady }));
    expect(await states(h, [consumedReady, other])).toEqual([["ready", null], ["stopped", "human_result"]]);

    const receipt = await h.t.run((ctx) => seedAppliedReceipt(ctx, {
      tenantId: h.tenantId, providerPaymentId: h.providerPaymentId, opportunityId: h.dealId!, leadId: h.personId,
      humanResultRevision: 1, humanResultRevisionAfter: undefined,
    }));
    const { revision } = await h.t.run((ctx) => noteHumanResult(ctx, h.dealId!, actorOf(h), { consumeDecisionId: receipt }));
    expect(revision).toBe(2);
    expect(await h.t.run((ctx) => ctx.db.get("resultAutomationDecisions", receipt))).toMatchObject({
      state: "applied", humanResultRevisionAfter: 2,
    });
  });

  it("refuses to consume a decision on another deal", async () => {
    const h = await providerPaymentFixture({ dealPosition: "booked" });
    const otherDecision = await h.t.run(async (ctx) => {
      const otherDeal = await ctx.db.insert("opportunities", {
        stage: "follow_up", outcome: "open", source: "calendly", tenantId: h.tenantId, leadId: h.personId,
        createdAt: 0, updatedAt: 0,
      });
      return await decision(ctx, h, "ready", { opportunityId: otherDeal });
    });
    await expect(h.t.run((ctx) => noteHumanResult(ctx, h.dealId!, actorOf(h), { consumeDecisionId: otherDecision })))
      .rejects.toThrow("is not on deal");
  });

  it("refuses a deal in another tenant", async () => {
    const h = await providerPaymentFixture({ dealPosition: "booked" });
    const otherTenant = await h.t.run((ctx) => ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0, companyName: "Other", contactEmail: "o@example.com", workosOrgId: "org_other",
      status: "active", inviteExpiresAt: 0, createdBy: "test",
    }));
    await expect(h.t.run((ctx) => noteHumanResult(ctx, h.dealId!, { tenantId: otherTenant, userId: h.closerId })))
      .rejects.toThrow("not found in this tenant");
  });

  it(`stops the first ${HUMAN_RESULT_STOP_BATCH} at once and the rest through the scheduled continuation`, async () => {
    const h = await providerPaymentFixture({ dealPosition: "booked" });
    const ids = await h.t.run(async (ctx) => {
      const rows: Id<"resultAutomationDecisions">[] = [];
      for (let index = 0; index < 60; index += 1) rows.push(await decision(ctx, h, "ready"));
      for (let index = 0; index < 5; index += 1) rows.push(await decision(ctx, h, "needs_person"));
      for (let index = 0; index < 3; index += 1) rows.push(await decision(ctx, h, "blocked"));
      return rows;
    });

    await h.t.run((ctx) => noteHumanResult(ctx, h.dealId!, actorOf(h)));
    const immediately = await states(h, ids);
    expect(immediately.filter(([state]) => state === "stopped")).toHaveLength(HUMAN_RESULT_STOP_BATCH);

    // A decision derived after the bump is current, and the continuation leaves it.
    const fresh = await h.t.run((ctx) => decision(ctx, h, "ready", { revision: 1 }));
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await states(h, ids)).every(([state, code]) => state === "stopped" && code === "human_result")).toBe(true);
    expect(await states(h, [fresh])).toEqual([["ready", null]]);
  });

  it("leaves the deal's decisions consistent with its revision", async () => {
    const h = await providerPaymentFixture({ dealPosition: "booked" });
    await h.t.run(async (ctx) => { await decision(ctx, h, "ready"); });
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });
    await h.t.run((ctx) => noteHumanResult(ctx, h.dealId!, actorOf(h)));
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });
  });

  it("asks for the person's Whop payments to be evaluated again", () => {
    expect(RE_EVALUATE_AFTER_HUMAN_RESULT).toBe(true);
  });
});
