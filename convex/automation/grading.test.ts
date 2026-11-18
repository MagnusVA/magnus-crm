import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import {
  automationFixtureApi, automationPaymentFixture, FIXTURE_NOW, insertProviderPerson,
  seedReadyDecision, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";

const { grading } = automationFixtureApi;

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
      tenantId: f.tenantId, leadId: f.personId, opportunityId: f.dealId, providerPaymentId: f.providerPaymentId,
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

describe("grade capture", () => {
  it("shows one case per person, oldest first, and reveals a proposal only after commitment", async () => {
    const f = await gradingFixture();
    const oldest = await sample(f);
    await sample(f, { createdAt: FIXTURE_NOW + 20 });
    const other = await f.t.run((ctx) => insertProviderPerson(ctx, f.tenantId, { email: "other@example.com" }));
    const second = await sample(f, { createdAt: FIXTURE_NOW + 10, leadId: other });
    const args = { kind: "payment_win", sample: "writes" } as const;
    const view = await f.admin.query(grading.listToGrade, args);
    expect(view).toEqual({
      cases: [
        { decisionId: oldest, providerPaymentId: f.providerPaymentId, createdAt: FIXTURE_NOW, answerCommitted: false },
        { decisionId: second, providerPaymentId: f.providerPaymentId, createdAt: FIXTURE_NOW + 10, answerCommitted: false },
      ],
      capped: false,
    });
    await expect(f.closer.query(grading.listToGrade, args)).rejects.toThrow("Insufficient permissions");
    await expect(f.admin.mutation(grading.recordGrade, {
      decisionId: oldest, verdict: "correct", wrongFields: [],
    })).rejects.toThrow("Commit your answer");
    await f.admin.mutation(grading.commitAnswer, { decisionId: oldest, answer: {
      abstain: false, amountMinor: 10000, currency: "USD", opportunityId: f.dealId,
    } });
    expect(await f.admin.mutation(grading.reveal, { decisionId: oldest })).toMatchObject({ amountMinor: 10000 });
    await f.admin.mutation(grading.recordGrade, { decisionId: oldest, verdict: "correct", wrongFields: [] });
    expect((await getDecision(f, oldest))?.grade).toMatchObject({ gradedBeforeSeeing: true, gradedByUserId: f.adminId });
    expect((await f.admin.query(grading.listToGrade, args)).cases.map((row) => row.decisionId)).toEqual([second]);
    await invariant(f);
  });

  it.each(["prior exposure", "confirmation"] as const)("does not count %s as a blind grade", async (reason) => {
    const f = await gradingFixture();
    const decisionId = await sample(f, { resolvedByUserId: reason === "confirmation" ? f.adminId : undefined });
    if (reason === "prior exposure") {
      expect(await f.admin.mutation(grading.reveal, { decisionId })).toBeNull();
      expect((await getDecision(f, decisionId))?.revealedToUserIds).toEqual([f.adminId]);
    }
    await f.admin.mutation(grading.commitAnswer, { decisionId, answer: { abstain: false } });
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
    await expect(f.admin.mutation(grading.resolveUnsure, { decisionId, verdict })).rejects.toThrow("Insufficient permissions");
    const tally = () => f.admin.query(grading.getGradeTally, { kind: "payment_win" });
    expect((await tally()).writes).toMatchObject({ cleanBlind: 0, unsure: 1, wrong: 0 });
    await f.owner.mutation(grading.resolveUnsure, { decisionId, verdict });
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
            tenantId: f.tenantId, leadId, providerPaymentId: f.providerPaymentId, createdAt: FIXTURE_NOW + i,
            wouldWrite: i < 10,
          });
          await ctx.db.patch("resultAutomationDecisions", id, patch);
          if (i === 0) {
            const duplicate = await seedReadyDecision(ctx, {
              tenantId: f.tenantId, leadId, providerPaymentId: f.providerPaymentId, createdAt: FIXTURE_NOW + 301,
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
