import { describe, expect, it } from "vitest";
import { PAYMENT_RULE_VERSION } from "./derive";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { stageOfPosition, type DealPosition } from "../opportunities/stages";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import { INVARIANT_IDS, assertPaymentInvariants } from "../../tests/paymentInvariants";
import {
  FIXTURE_NOW,
  automationCallFixture,
  insertProviderPerson,
  seedAutomationSample,
  seedCallDecision,
  seedReadyDecision,
  setKindAutomatic,
} from "../../tests/providerPaymentFixtures";
import { seedProviderRow } from "../../tests/providerRowFixtures";

type Fixture = Awaited<ReturnType<typeof automationCallFixture>>;
type CallKind = "call_back" | "payment_owed" | "refusal_loss" | "paid_on_call_alert";

const HOUR = 3_600_000;
const LOST_AT = FIXTURE_NOW + 5 * 60_000;

/** The invariant ids the assertion reports, or none. */
async function broken(f: Fixture): Promise<string[]> {
  try {
    await assertAutomationInvariants(f.t, { tenantId: f.tenantId });
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [...new Set([...message.matchAll(/^(A\d+):/gm)].map((match) => match[1]))].sort();
  }
}

function seedCall(
  f: Fixture, ctx: MutationCtx, kind: CallKind, fields: Partial<Omit<Doc<"resultAutomationDecisions">, "kind">> = {},
) {
  return seedCallDecision(ctx, {
    tenantId: f.tenantId, kind, opportunityId: f.opportunityId, leadId: f.personId, meetingId: f.meetingId,
    closerId: f.closerId, runId: f.runId, recordingId: f.recordingId, ...fields,
  });
}

function certifiedSample(
  f: Fixture, ctx: MutationCtx, kind: Doc<"automationSamples">["kind"], ruleVersion: string,
  fields: Partial<Doc<"automationSamples">> = {},
) {
  return seedAutomationSample(ctx, {
    tenantId: f.tenantId, kind, ruleVersion, target: 1, status: "certified",
    fullAt: FIXTURE_NOW, certifiedAt: FIXTURE_NOW, ...fields,
  });
}

function insertTask(f: Fixture, ctx: MutationCtx, fields: Partial<Doc<"followUps">> = {}) {
  return ctx.db.insert("followUps", {
    tenantId: f.tenantId, opportunityId: f.opportunityId, leadId: f.personId, closerId: f.closerId,
    type: "manual_reminder", reason: "closer_initiated", status: "pending", contactMethod: "call",
    reminderScheduledAt: FIXTURE_NOW + 86_400_000, createdAt: FIXTURE_NOW, ...fields,
  });
}

// A test may close the deal by hand: the invariants read rows, not how they were written.
function moveDeal(f: Fixture, ctx: MutationCtx, position: DealPosition, fields: Partial<Doc<"opportunities">> = {}) {
  return ctx.db.patch("opportunities", f.opportunityId, { ...stageOfPosition(position), ...fields });
}

const paymentOwedTask = {
  purpose: "payment_owed" as const,
  expectedAmountMinor: 50_000,
  expectedCurrency: "USD",
  promisedPaymentAt: FIXTURE_NOW + 2 * 86_400_000,
};

describe("assertAutomationInvariants", () => {
  it("passes on a deal with a scheduled call, its recording and its run", async () => {
    const f = await automationCallFixture();
    expect(await broken(f)).toEqual([]);
  });

  describe("A1: a held mark from Call insights names its applied call decision", () => {
    it("passes a meeting held by its applied call-back decision", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        const decisionId = await seedCall(f, ctx, "call_back", { state: "applied", resolvedAt: FIXTURE_NOW });
        await ctx.db.patch("meetings", f.meetingId, {
          status: "held", heldMarkedAt: FIXTURE_NOW, attendanceSource: "call_insights", attendanceDecisionId: decisionId,
        });
      });
      expect(await broken(f)).toEqual([]);
    });

    it("fails a call held mark with no decision", async () => {
      const f = await automationCallFixture();
      await f.t.run((ctx) => ctx.db.patch("meetings", f.meetingId, {
        status: "held", heldMarkedAt: FIXTURE_NOW, attendanceSource: "call_insights",
      }));
      expect(await broken(f)).toEqual(["A1"]);
    });
  });

  describe("A2: tasks a decision wrote", () => {
    it("passes a payment-owed task with its amount, currency and promised date", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        const decisionId = await seedCall(f, ctx, "payment_owed", { state: "applied", resolvedAt: FIXTURE_NOW });
        await insertTask(f, ctx, { reason: "call_insights", automationDecisionId: decisionId, ...paymentOwedTask });
      });
      expect(await broken(f)).toEqual([]);
    });

    it("fails a task a decision wrote that holds a note", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        const decisionId = await seedCall(f, ctx, "payment_owed", { state: "applied", resolvedAt: FIXTURE_NOW });
        await insertTask(f, ctx, {
          reason: "call_insights", automationDecisionId: decisionId, reminderNote: "Synthetic note", ...paymentOwedTask,
        });
      });
      expect(await broken(f)).toEqual(["A2"]);
    });
  });

  describe("A3: a call refusal loss is an applied refusal decision's", () => {
    it("passes a refusal the closer confirmed", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        await seedCall(f, ctx, "refusal_loss", { state: "applied", resolvedAt: LOST_AT, resolvedByUserId: f.closerId });
        await moveDeal(f, ctx, "lost", { lostReason: "call_refusal", lostAt: LOST_AT, lostByUserId: f.closerId });
      });
      expect(await broken(f)).toEqual([]);
    });

    it("fails a refusal whose loss names another person than the decision", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        await seedCall(f, ctx, "refusal_loss", { state: "applied", resolvedAt: LOST_AT, resolvedByUserId: f.adminId });
        await moveDeal(f, ctx, "lost", { lostReason: "call_refusal", lostAt: LOST_AT, lostByUserId: f.closerId });
      });
      expect(await broken(f)).toEqual(["A3"]);
    });
  });

  describe("A4: a notice's clock starts on acknowledgment", () => {
    const acknowledged = {
      state: "notice" as const, mode: "automatic" as const, noticeRound: 1, acknowledgedAt: FIXTURE_NOW,
      acknowledgedByUserId: undefined, acknowledgedAs: "closer" as const, noticeHours: 48,
    };

    it("passes an acknowledged notice due its hours later", async () => {
      const f = await automationCallFixture();
      await f.t.run((ctx) => seedCall(f, ctx, "refusal_loss", { ...acknowledged, dueAt: FIXTURE_NOW + 48 * HOUR }));
      expect(await broken(f)).toEqual([]);
    });

    it("fails a notice due earlier than its hours", async () => {
      const f = await automationCallFixture();
      await f.t.run((ctx) => seedCall(f, ctx, "refusal_loss", { ...acknowledged, dueAt: FIXTURE_NOW + 24 * HOUR }));
      expect(await broken(f)).toEqual(["A4"]);
    });
  });

  describe("A5: an outstanding refusal waits on an open deal and a scheduled call", () => {
    it("passes a refusal ask on a booked deal with no task", async () => {
      const f = await automationCallFixture();
      await f.t.run((ctx) => seedCall(f, ctx, "refusal_loss"));
      expect(await broken(f)).toEqual([]);
    });

    it("fails a refusal ask beside a pending task", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        await seedCall(f, ctx, "refusal_loss");
        await insertTask(f, ctx);
      });
      expect(await broken(f)).toEqual(["A5"]);
    });
  });

  describe("A6: an automatic write names its certificate", () => {
    it("passes an automatic refusal written under a certified sample", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        const sampleId = await certifiedSample(f, ctx, "refusal_loss", "call-rule@1");
        await seedCall(f, ctx, "refusal_loss", {
          state: "applied", mode: "automatic", resolvedAt: LOST_AT, certificateSampleId: sampleId,
        });
        await moveDeal(f, ctx, "lost", { lostReason: "call_refusal", lostAt: LOST_AT });
      });
      expect(await broken(f)).toEqual([]);
    });

    it("fails an automatic write under a sample still collecting", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        const sampleId = await certifiedSample(f, ctx, "refusal_loss", "call-rule@1", {
          status: "collecting", fullAt: undefined, certifiedAt: undefined,
        });
        await seedCall(f, ctx, "refusal_loss", {
          state: "applied", mode: "automatic", resolvedAt: LOST_AT, certificateSampleId: sampleId,
        });
      });
      expect(await broken(f)).toEqual(["A6"]);
    });
  });

  describe("A7: an automatic kind points at a full certificate", () => {
    async function promoted(withPointer: boolean) {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        const sampleId = await certifiedSample(f, ctx, "payment_win", PAYMENT_RULE_VERSION);
        await seedReadyDecision(ctx, {
          tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, opportunityId: f.opportunityId,
          leadId: f.personId, sampleId,
        });
        await setKindAutomatic(ctx, {
          tenantId: f.tenantId, adminId: f.adminId, kind: "payment_win", sampleId: withPointer ? sampleId : undefined,
        });
      });
      return f;
    }

    it("passes a kind promoted on a certified sample of its target size", async () => {
      expect(await broken(await promoted(true))).toEqual([]);
    });

    it("fails a kind stored as automatic with no certificate pointer", async () => {
      expect(await broken(await promoted(false))).toEqual(["A7"]);
    });
  });

  describe("A8: one member per person, all eligible", () => {
    async function sampled(secondLeadIsSame: boolean) {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        const sampleId = await seedAutomationSample(ctx, { tenantId: f.tenantId, target: 2 });
        const otherLeadId = secondLeadIsSame
          ? f.personId
          : await insertProviderPerson(ctx, f.tenantId, { fullName: "Sky Moreno", email: "sky@example.com" });
        for (const [leadId, createdAt] of [[f.personId, FIXTURE_NOW], [otherLeadId, FIXTURE_NOW + 1]] as const) {
          await seedReadyDecision(ctx, {
            tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, opportunityId: f.opportunityId,
            leadId, sampleId, createdAt,
          });
        }
      });
      return f;
    }

    it("passes two people in a sample of two", async () => {
      expect(await broken(await sampled(false))).toEqual([]);
    });

    it("fails the same person twice in one sample", async () => {
      expect(await broken(await sampled(true))).toEqual(["A8"]);
    });
  });

  describe("A9: a row with no recorder is an automatic write's", () => {
    async function unrecordedRow(withDecision: boolean) {
      const f = await automationCallFixture();
      const paymentRecordId = await f.t.run(async (ctx) => {
        const rowId = await seedProviderRow(ctx, {
          tenantId: f.tenantId, opportunityId: f.opportunityId, closerId: f.closerId, programId: f.programId,
          providerPaymentId: f.providerPaymentId, amountMinor: 10_000, recordedAt: FIXTURE_NOW, recorder: "absent",
        });
        if (withDecision) {
          const sampleId = await certifiedSample(f, ctx, "payment_win", PAYMENT_RULE_VERSION);
          const decisionId = await seedReadyDecision(ctx, {
            tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, opportunityId: f.opportunityId,
            leadId: f.personId, appliedPaymentRecordId: rowId, appliedVia: "automatic", resolvedAt: FIXTURE_NOW,
            certificateSampleId: sampleId,
          });
          await ctx.db.patch("resultAutomationDecisions", decisionId, { state: "applied", mode: "automatic" });
          await ctx.db.patch("paymentRecords", rowId, { automationDecisionId: decisionId });
        }
        return rowId;
      });
      return { f, paymentRecordId };
    }

    it("passes a provider row an applied automatic decision wrote", async () => {
      const { f } = await unrecordedRow(true);
      expect(await broken(f)).toEqual([]);
    });

    it("fails a provider row with no recorder and no decision", async () => {
      const { f } = await unrecordedRow(false);
      expect(await broken(f)).toEqual(["A9"]);
    });

    // The payment invariants' I5 now allows the same row (contract §5, A9).
    it("widens I5 to the automatic write and keeps it for any other row", async () => {
      const skip = INVARIANT_IDS.filter((id) => id !== "I5");
      const automatic = await unrecordedRow(true);
      await expect(assertPaymentInvariants(automatic.f.t, { tenantId: automatic.f.tenantId }, { skip }))
        .resolves.toBeUndefined();
      const bare = await unrecordedRow(false);
      await expect(assertPaymentInvariants(bare.f.t, { tenantId: bare.f.tenantId }, { skip }))
        .rejects.toThrow(`I5: row ${bare.paymentRecordId} has no recorder`);
    });
  });

  describe("A10: the first payment closes payment-owed tasks in its currency", () => {
    async function wonWithTask(currency: string) {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        await seedProviderRow(ctx, {
          tenantId: f.tenantId, opportunityId: f.opportunityId, closerId: f.closerId, programId: f.programId,
          amountMinor: 10_000, currency: "USD", recordedAt: FIXTURE_NOW, recorder: f.adminId,
        });
        await moveDeal(f, ctx, "won", { paymentReceivedAt: FIXTURE_NOW });
        await insertTask(f, ctx, { ...paymentOwedTask, expectedCurrency: currency });
      });
      return f;
    }

    it("passes a pending payment-owed task in another currency", async () => {
      expect(await broken(await wonWithTask("EUR"))).toEqual([]);
    });

    it("fails a pending payment-owed task in the payment's currency", async () => {
      expect(await broken(await wonWithTask("USD"))).toEqual(["A10"]);
    });
  });

  describe("A11: one outstanding call decision per meeting and family", () => {
    it("passes a call-back ask beside a refusal ask", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        await seedCall(f, ctx, "call_back");
        await seedCall(f, ctx, "refusal_loss");
      });
      expect(await broken(f)).toEqual([]);
    });

    it("fails a call-back ask beside a payment-owed ask, which share the task family", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        await seedCall(f, ctx, "call_back");
        await seedCall(f, ctx, "payment_owed");
      });
      expect(await broken(f)).toEqual(["A11"]);
    });

    it("fails an open audit on a decision that isn't an automatic write", async () => {
      const f = await automationCallFixture();
      await f.t.run((ctx) => seedCall(f, ctx, "call_back", { auditOpenDueAt: FIXTURE_NOW + 86_400_000 }));
      expect(await broken(f)).toEqual(["A11"]);
    });
  });

  describe("A12: words", () => {
    it("passes a run whose quotes were blanked at the purge", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        const run = (await ctx.db.get("callInsightRuns", f.runId))!;
        await ctx.db.patch("callInsightRuns", f.runId, {
          quotesPurgedAt: FIXTURE_NOW,
          evidence: { ...run.evidence!, statements: run.evidence!.statements.map((statement) => ({ ...statement, quote: "" })) },
        });
        await seedCall(f, ctx, "refusal_loss");
      });
      expect(await broken(f)).toEqual([]);
    });

    it("fails a purged run that keeps a quote", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        await ctx.db.patch("callInsightRuns", f.runId, { quotesPurgedAt: FIXTURE_NOW });
        await seedCall(f, ctx, "refusal_loss");
      });
      expect(await broken(f)).toEqual(["A12"]);
    });

    it("fails a decision that stores free text", async () => {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        const decisionId = await seedCall(f, ctx, "payment_owed");
        const decision = (await ctx.db.get("resultAutomationDecisions", decisionId))!;
        await ctx.db.patch("resultAutomationDecisions", decisionId, {
          proposal: { ...decision.proposal!, declineCode: "Card was declined twice" } as Doc<"resultAutomationDecisions">["proposal"],
        });
      });
      expect(await broken(f)).toEqual(["A12"]);
    });
  });

  describe("A13: a held mapping takes no later automatic write", () => {
    async function heldMapping(writtenAt: number) {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        await ctx.db.patch("paymentProviderBindings", f.productBindingId, { automaticHeldAt: FIXTURE_NOW });
        const sampleId = await certifiedSample(f, ctx, "payment_win", PAYMENT_RULE_VERSION);
        const decisionId = await seedReadyDecision(ctx, {
          tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, opportunityId: f.opportunityId,
          leadId: f.personId, resolvedAt: writtenAt, certificateSampleId: sampleId, appliedVia: "automatic",
          evidence: { allocationRevision: 0, sourceUpdatedAt: FIXTURE_NOW, bindingIds: [f.productBindingId], bindingVersions: [1] },
        });
        await ctx.db.patch("resultAutomationDecisions", decisionId, { state: "applied", mode: "automatic" });
      });
      return f;
    }

    it("passes an automatic write made before the mapping was held", async () => {
      expect(await broken(await heldMapping(FIXTURE_NOW - 1))).toEqual([]);
    });

    it("fails an automatic write on the mapping after it was held", async () => {
      expect(await broken(await heldMapping(FIXTURE_NOW + 1))).toEqual(["A13"]);
    });
  });

  describe("A14: an automatic task write whose meeting is scheduled again was undone", () => {
    async function automaticCallBack(state: "applied" | "undone") {
      const f = await automationCallFixture();
      await f.t.run(async (ctx) => {
        const sampleId = await certifiedSample(f, ctx, "call_back", "call-rule@1");
        await seedCall(f, ctx, "call_back", {
          state, mode: "automatic", resolvedAt: FIXTURE_NOW, certificateSampleId: sampleId,
          callBefore: { position: "booked", meetingId: f.meetingId, meetingStatus: "scheduled", latestActivityAt: FIXTURE_NOW },
        });
      });
      return f;
    }

    it("passes an undone write", async () => {
      expect(await broken(await automaticCallBack("undone"))).toEqual([]);
    });

    it("fails a write still applied while its meeting is scheduled", async () => {
      expect(await broken(await automaticCallBack("applied"))).toEqual(["A14"]);
    });
  });

  it("skips the invariants the caller names", async () => {
    const f = await automationCallFixture();
    await f.t.run((ctx) => ctx.db.patch("meetings", f.meetingId, {
      status: "held", heldMarkedAt: FIXTURE_NOW, attendanceSource: "call_insights",
    }));
    await expect(assertAutomationInvariants(f.t, { tenantId: f.tenantId })).rejects.toThrow("A1:");
    await expect(assertAutomationInvariants(f.t, { tenantId: f.tenantId }, { skip: ["A1"] })).resolves.toBeUndefined();
  });

  it("reads only the deals and meetings in scope when given", async () => {
    const f = await automationCallFixture();
    await f.t.run((ctx) => ctx.db.patch("meetings", f.meetingId, {
      status: "held", heldMarkedAt: FIXTURE_NOW, attendanceSource: "call_insights",
    }));
    const otherDealId = await f.t.run((ctx) => ctx.db.insert("opportunities", {
      ...stageOfPosition("booked"), source: "calendly", tenantId: f.tenantId, leadId: f.personId,
      createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW,
    }));
    await expect(assertAutomationInvariants(f.t, { tenantId: f.tenantId, opportunityIds: [otherDealId as Id<"opportunities">] }))
      .resolves.toBeUndefined();
    await expect(assertAutomationInvariants(f.t, { tenantId: f.tenantId, meetingIds: [f.meetingId] })).rejects.toThrow("A1:");
  });
});
