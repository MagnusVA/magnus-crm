import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import {
  automationFixtureApi, automationPaymentFixture, FIXTURE_NOW, FIXTURE_PAID_AT, insertProviderPerson, PAYER_EMAIL,
  seedReadyDecision, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";

import { PAYMENT_RULE_VERSION } from "./derive";

const { grading, settings } = automationFixtureApi;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Fixture = Awaited<ReturnType<typeof automationPaymentFixture>>;

async function gradingFixture() {
  const f = await automationPaymentFixture();
  await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
  return f;
}

async function sample(f: Fixture, options: {
  createdAt?: number; leadId?: Id<"leads">; resolvedByUserId?: Id<"users">; wouldWrite?: boolean;
} = {}) {
  return await f.t.run(async (ctx) => {
    const id = await seedReadyDecision(ctx, {
      ruleVersion: PAYMENT_RULE_VERSION,
      tenantId: f.tenantId, leadId: f.personId, opportunityId: f.dealId, providerPaymentId: f.providerPaymentId,
      noticeUserId: f.closerId,
      proposal: {
        amountMinor: 10000, currency: "USD", paymentType: "pif",
        programId: f.programId, attributedCloserId: f.closerId, expiresFollowUpIds: [],
      },
      ...options,
    });
    await ctx.db.patch("resultAutomationDecisions", id, { state: "shadow" });
    return id;
  });
}

const invariant = (f: Fixture) => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
const getDecision = (f: Fixture, id: Id<"resultAutomationDecisions">) =>
  f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", id));

const evidence = {
  amountMinor: 10000,
  currency: "USD",
  paidAt: FIXTURE_PAID_AT,
  productTitle: "Sales training",
  variantTitle: "Pay in full",
  payerEmail: PAYER_EMAIL,
  billingReason: "one_time",
  hasMembership: false,
  environment: "sandbox",
};

describe("grade capture", () => {
  it("shows one case per person, oldest first, and keeps the grade blind after commitment", async () => {
    const f = await gradingFixture();
    const oldest = await sample(f);
    await sample(f, { createdAt: FIXTURE_NOW + 20 });
    const other = await f.t.run((ctx) => insertProviderPerson(ctx, f.tenantId, { email: "other@example.com" }));
    const second = await sample(f, { createdAt: FIXTURE_NOW + 10, leadId: other });
    const args = { kind: "payment_win", sample: "writes" } as const;
    const view = await f.admin.query(grading.listToGrade, args);
    expect(view).toEqual({
      cases: [
        { decisionId: oldest, createdAt: FIXTURE_NOW, answerCommitted: false, evidence },
        { decisionId: second, createdAt: FIXTURE_NOW + 10, answerCommitted: false, evidence },
      ],
      capped: false,
    });
    await expect(f.closer.query(grading.listToGrade, args)).rejects.toThrow("Insufficient permissions");
    await expect(f.admin.mutation(grading.recordGrade, {
      decisionId: oldest, verdict: "correct", wrongFields: [],
    })).rejects.toThrow("Commit your answer");
    const answer = {
      abstain: false, amountMinor: 10000, currency: "USD", opportunityId: f.dealId,
    };
    await f.admin.mutation(grading.commitAnswer, { decisionId: oldest, answer });
    expect(await f.admin.mutation(grading.reveal, { decisionId: oldest })).toMatchObject({
      kind: "payment_win", proposal: { amountMinor: 10000 }, leadId: f.personId,
      opportunityId: f.dealId, wouldWrite: true, gates: [],
    });
    expect(await f.admin.query(grading.getMyAnswer, { decisionId: oldest })).toEqual({ answer, blind: true });
    expect(await f.owner.query(grading.getMyAnswer, { decisionId: oldest })).toBeNull();
    await f.admin.mutation(grading.recordGrade, { decisionId: oldest, verdict: "correct", wrongFields: [] });
    expect((await getDecision(f, oldest))?.grade).toMatchObject({ gradedBeforeSeeing: true, gradedByUserId: f.adminId });
    expect((await f.admin.query(grading.listToGrade, args)).cases.map((row) => row.decisionId)).toEqual([second]);
    await invariant(f);
  });

  it("only the designated grader can read, answer, reveal and grade a case", async () => {
    const f = await gradingFixture();
    const decisionId = await sample(f);
    const formerCase = await sample(f, { createdAt: FIXTURE_NOW + 1 });
    const answer = { abstain: false };
    await f.owner.mutation(grading.commitAnswer, { decisionId: formerCase, answer });
    await f.owner.mutation(settings.setGrader, { userId: f.adminId });
    const args = { kind: "payment_win", sample: "writes" } as const;
    const denied = "Only the designated grader can grade cases.";
    // Queries answer with nothing, so the owner's panel still renders.
    expect(await f.owner.query(grading.listToGrade, args)).toEqual({ cases: [], capped: false, notGrader: true });
    expect(await f.owner.query(grading.getMyAnswer, { decisionId: formerCase })).toBeNull();
    await expect(f.owner.mutation(grading.commitAnswer, { decisionId, answer })).rejects.toThrow(denied);
    await expect(f.owner.mutation(grading.reveal, { decisionId })).rejects.toThrow(denied);
    await expect(f.owner.mutation(grading.recordGrade, { decisionId: formerCase, verdict: "correct", wrongFields: [] }))
      .rejects.toThrow(denied);
    expect((await f.admin.query(grading.listToGrade, args)).cases.map((row) => row.decisionId)).toContain(decisionId);
    await f.admin.mutation(grading.commitAnswer, { decisionId, answer });
    expect(await f.admin.query(grading.getMyAnswer, { decisionId })).toEqual({ answer, blind: true });
    expect(await f.admin.mutation(grading.reveal, { decisionId })).toMatchObject({ kind: "payment_win" });
    await f.admin.mutation(grading.recordGrade, { decisionId, verdict: "unsure", wrongFields: [] });
    await f.owner.mutation(grading.resolveUnsure, { decisionId, verdict: "correct" });
    expect((await getDecision(f, decisionId))?.grade?.secondLook?.verdict).toBe("correct");

    // The named grader takes over the case the owner answered and never graded.
    await f.admin.mutation(grading.commitAnswer, { decisionId: formerCase, answer });
    await f.admin.mutation(grading.recordGrade, { decisionId: formerCase, verdict: "correct", wrongFields: [] });
    expect(await getDecision(f, formerCase)).toMatchObject({
      answer: { committedByUserId: f.adminId }, grade: { gradedByUserId: f.adminId, verdict: "correct" },
    });
  });

  it("keeps all proposal and match fields out of the pre-commit JSON with Billing off", async () => {
    const f = await gradingFixture();
    const decisionId = await sample(f);
    await f.t.run(async (ctx) => {
      await ctx.db.patch("tenants", f.tenantId, { billingOpsEnabled: false });
      await ctx.db.patch("tenantPaymentConnections", f.connectionId, { status: "disconnected" });
      await ctx.db.patch("providerPayments", f.providerPaymentId, {
        candidateLeadId: f.personId,
        candidateOpportunityId: f.dealId,
        leadId: f.personId,
        opportunityId: f.dealId,
        reviewReason: "ready",
        membershipId: "mem_fixture",
      });
      await ctx.db.patch("resultAutomationDecisions", decisionId, { gates: ["refund"] });
    });

    const queue = await f.admin.query(grading.listToGrade, { kind: "payment_win", sample: "writes" });
    const answer = await f.admin.query(grading.getMyAnswer, { decisionId });
    expect(queue.cases).toEqual([
      { decisionId, createdAt: FIXTURE_NOW, answerCommitted: false, evidence: { ...evidence, hasMembership: true } },
    ]);
    expect(answer).toBeNull();
    const forbidden = [
      "leadId", "opportunityId", "proposal", "gates", "wouldWrite", "confirmRoute", "noticeUserId",
      "candidateLeadId", "candidateOpportunityId", "reviewReason", f.personId, f.dealId,
    ];
    JSON.parse(JSON.stringify([queue, answer]), (key, value: unknown) => {
      expect(forbidden).not.toContain(key);
      if (typeof value === "string") {
        for (const field of forbidden) expect(value).not.toContain(field);
      }
      return value;
    });
    await f.t.run((ctx) =>
      ctx.db.patch("providerPayments", f.providerPaymentId, { payerDetailsExpireAt: FIXTURE_NOW }),
    );
    const expired = await f.admin.query(grading.listToGrade, { kind: "payment_win", sample: "writes" });
    expect(expired.cases[0].evidence?.payerEmail).toBeUndefined();
  });

  it.each(["prior exposure", "confirmation"] as const)("does not count %s as a blind grade", async (reason) => {
    const f = await gradingFixture();
    const decisionId = await sample(f, { resolvedByUserId: reason === "confirmation" ? f.adminId : undefined });
    if (reason === "prior exposure") {
      const revealed = await f.admin.mutation(grading.reveal, { decisionId });
      expect(revealed).toMatchObject({
        kind: "payment_win", proposal: { amountMinor: 10000 }, leadId: f.personId,
        opportunityId: f.dealId, wouldWrite: true, gates: [],
      });
      expect(await f.admin.mutation(grading.reveal, { decisionId })).toEqual(revealed);
      expect((await getDecision(f, decisionId))?.revealedToUserIds).toEqual([f.adminId]);
    }
    await f.admin.mutation(grading.commitAnswer, { decisionId, answer: { abstain: false } });
    expect(await f.admin.query(grading.getMyAnswer, { decisionId })).toEqual({
      answer: { abstain: false }, blind: false,
    });
    await f.admin.mutation(grading.recordGrade, { decisionId, verdict: "correct", wrongFields: [] });
    expect((await getDecision(f, decisionId))?.grade?.gradedBeforeSeeing).toBe(false);
    expect((await f.admin.query(grading.getGradeTally, { kind: "payment_win" })).writes).toMatchObject({
      cleanBlind: 0, blind: 0, exposed: 1,
    });
    await invariant(f);
  });

  it.each(["correct", "wrong"] as const)("retains unsure and lets only an owner adjudicate %s", async (verdict) => {
    const f = await gradingFixture();
    const decisionId = await sample(f);
    await f.admin.mutation(grading.commitAnswer, { decisionId, answer: { abstain: false } });
    await f.admin.mutation(grading.recordGrade, { decisionId, verdict: "unsure", wrongFields: ["type"] });
    const args = { kind: "payment_win" } as const;
    await expect(f.admin.query(grading.listUnsure, args)).rejects.toThrow("Insufficient permissions");
    await expect(f.admin.mutation(grading.resolveUnsure, { decisionId, verdict })).rejects.toThrow("Insufficient permissions");
    const tally = () => f.admin.query(grading.getGradeTally, args);
    expect((await tally()).writes).toMatchObject({ cleanBlind: 0, unsure: 1, wrong: 0 });
    expect(await f.owner.query(grading.listUnsure, args)).toEqual([{
      decisionId, createdAt: FIXTURE_NOW, gradedAt: FIXTURE_NOW,
      gradedByName: await f.t.run(async (ctx) => {
        const admin = (await ctx.db.get("users", f.adminId))!;
        return admin.fullName?.trim() || admin.email;
      }),
      wrongFields: ["type"],
      evidence,
      proposal: await f.admin.mutation(grading.reveal, { decisionId }),
      answer: { abstain: false },
    }]);
    await f.owner.mutation(grading.resolveUnsure, { decisionId, verdict });
    expect(await f.owner.query(grading.listUnsure, args)).toEqual([]);
    expect((await getDecision(f, decisionId))?.grade).toMatchObject({
      verdict: "unsure", wrongFields: ["type"], secondLook: { verdict, byUserId: f.ownerId },
    });
    expect((await tally()).writes).toMatchObject({ cleanBlind: Number(verdict === "correct"), unsure: 0, wrong: Number(verdict === "wrong") });
    await invariant(f);
  });

  it("counts 290 clean abstentions separately from 10 distinct clean writes, across repeated people", async () => {
    const f = await gradingFixture();
    for (let offset = 0; offset < 300; offset += 50) {
      await f.t.run(async (ctx) => {
        for (let i = offset; i < offset + 50; i++) {
          const leadId = await insertProviderPerson(ctx, f.tenantId, { email: `sample-${i}@example.com` });
          const patch = {
            state: "shadow" as const,
            grade: {
              verdict: "correct" as const, wrongFields: [], gradedByUserId: f.adminId,
              gradedAt: FIXTURE_NOW + 1, gradedBeforeSeeing: true,
            },
          };
          const id = await seedReadyDecision(ctx, {
            ruleVersion: PAYMENT_RULE_VERSION, tenantId: f.tenantId, leadId, providerPaymentId: f.providerPaymentId, createdAt: FIXTURE_NOW + i,
            wouldWrite: i < 10,
          });
          await ctx.db.patch("resultAutomationDecisions", id, patch);
          if (i === 0) {
            const duplicate = await seedReadyDecision(ctx, {
              ruleVersion: PAYMENT_RULE_VERSION, tenantId: f.tenantId, leadId, providerPaymentId: f.providerPaymentId, createdAt: FIXTURE_NOW + 301,
            });
            await ctx.db.patch("resultAutomationDecisions", duplicate, patch);
          }
        }
      });
    }
    expect(await f.admin.query(grading.getGradeTally, { kind: "payment_win" })).toEqual({
      writes: { cleanBlind: 10, wrong: 0, unsure: 0, blind: 11, exposed: 0 },
      abstentions: { cleanBlind: 290, wrong: 0, unsure: 0, blind: 290, exposed: 0 },
      capped: false,
    });
    await invariant(f);
  });
});
