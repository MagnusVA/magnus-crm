import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  book,
  enrollmentHarness,
  sideDeal,
  twoPrograms,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";
import { storeProofFile } from "../../tests/proofFixtures";
import { PROOF_MAX_BYTES, PROOF_REQUIRED_MESSAGE } from "../lib/paymentProof";
import { checkMeetingPaymentAllowed, recordMeetingPayment } from "./payments";
import { recordTaskPayment } from "./reminderOutcomes";

// No proof, no payment for closers (docs/plans/closer-assistant.md §5.3,
// decision 3), and the fields every new payment gets (§6.3).

afterEach(() => vi.useRealTimers());

const CALL_LOGGED = Date.parse("2026-10-01T12:40:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
type Who = "closer" | "admin";

async function setup() {
  const harness = await enrollmentHarness();
  const { programA } = await twoPrograms(harness);
  return { harness, programId: programA };
}

async function bookedAndLogged(harness: EnrollmentHarness, key: string) {
  const deal = await book(harness, key, `${key}@example.com`);
  vi.setSystemTime(new Date(CALL_LOGGED));
  return deal;
}

/** Each of the four public payment paths, ready for one payment. */
const PATHS = {
  meeting: async (harness: EnrollmentHarness, programId: Id<"tenantPrograms">) => {
    const deal = await bookedAndLogged(harness, "meeting");
    return (who: Who, proofFileId?: Id<"_storage">) =>
      harness[who].mutation(api.closer.payments.logPayment, {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        amount: 100,
        currency: "USD",
        programId,
        paymentType: "pif",
        proofFileId,
      });
  },
  task: async (harness: EnrollmentHarness, programId: Id<"tenantPrograms">) => {
    const deal = await bookedAndLogged(harness, "task");
    const followUpId = await harness.t.run((ctx) =>
      ctx.db.insert("followUps", {
        tenantId: harness.tenantId,
        opportunityId: deal.opportunityId,
        leadId: deal.leadId,
        closerId: harness.closerId,
        type: "manual_reminder",
        reason: "closer_initiated",
        status: "pending",
        createdAt: 0,
      }),
    );
    return (who: Who, proofFileId?: Id<"_storage">) =>
      harness[who].mutation(api.closer.reminderOutcomes.logReminderPayment, {
        followUpId,
        amount: 100,
        currency: "USD",
        programId,
        paymentType: "deposit",
        proofFileId,
      });
  },
  additional: async (harness: EnrollmentHarness, programId: Id<"tenantPrograms">) => {
    const deal = await bookedAndLogged(harness, "additional");
    await harness.admin.mutation(api.closer.payments.logPayment, {
      opportunityId: deal.opportunityId,
      meetingId: deal.meetingId,
      amount: 100,
      currency: "USD",
      programId,
      paymentType: "deposit",
    });
    vi.setSystemTime(new Date(CALL_LOGGED + DAY_MS));
    return (who: Who, proofFileId?: Id<"_storage">) =>
      harness[who].mutation(api.closer.additionalPayment.recordAdditionalPayment, {
        opportunityId: deal.opportunityId,
        amount: 50,
        currency: "USD",
        paymentType: "split",
        proofFileId,
      });
  },
  sideDeal: async (harness: EnrollmentHarness, programId: Id<"tenantPrograms">) => {
    const { opportunityId } = await sideDeal(harness, "side", { email: "side@example.com" });
    return (who: Who, proofFileId?: Id<"_storage">) =>
      harness[who].mutation(api.sideDeals.logPayment.logPayment, {
        opportunityId,
        amount: 100,
        currency: "USD",
        programId,
        paymentType: "pif",
        proofFileId,
      });
  },
};

async function paymentOf(harness: EnrollmentHarness, result: unknown) {
  const paymentId =
    typeof result === "string"
      ? (result as Id<"paymentRecords">)
      : (result as { paymentId: Id<"paymentRecords"> }).paymentId;
  return (await harness.t.run((ctx) => ctx.db.get("paymentRecords", paymentId)))!;
}

async function paymentCount(harness: EnrollmentHarness) {
  return (await harness.t.run((ctx) => ctx.db.query("paymentRecords").take(50))).length;
}

describe.each(Object.entries(PATHS))("the %s payment", (_name, path) => {
  it("refuses a closer's payment without proof, and writes nothing", async () => {
    const { harness, programId } = await setup();
    const pay = await path(harness, programId);
    const before = await paymentCount(harness);
    await expect(pay("closer")).rejects.toThrow(PROOF_REQUIRED_MESSAGE);
    expect(await paymentCount(harness)).toBe(before);
  });

  it("takes a closer's payment with proof, and stores its hash", async () => {
    const { harness, programId } = await setup();
    const pay = await path(harness, programId);
    const proofFileId = await storeProofFile(harness.t, { contentType: "application/pdf" });
    const sha256 = (await harness.t.run((ctx) => ctx.db.system.get("_storage", proofFileId)))!.sha256;
    const payment = await paymentOf(harness, await pay("closer", proofFileId));
    expect(payment).toMatchObject({ proofFileId, proofSha256: sha256, recordedVia: "web" });
    expect(payment.proofReused).toBeUndefined();
    expect(payment.agentClient).toBeUndefined();
  });

  it("keeps proof optional for an admin", async () => {
    const { harness, programId } = await setup();
    const pay = await path(harness, programId);
    const payment = await paymentOf(harness, await pay("admin"));
    expect(payment.recordedVia).toBe("web");
    expect(payment.proofFileId).toBeUndefined();
    expect(payment.proofSha256).toBeUndefined();
  });

  it.each([
    ["over 10 MB", { size: PROOF_MAX_BYTES + 1 }, "over 10 MB"],
    ["a text file", { contentType: "text/plain" }, "must be a JPEG, PNG, GIF or PDF"],
    ["a file with no type", { contentType: null }, "must be a JPEG, PNG, GIF or PDF"],
  ] as const)("refuses a proof file %s, from an admin too", async (_label, file, message) => {
    const { harness, programId } = await setup();
    const pay = await path(harness, programId);
    const proofFileId = await storeProofFile(harness.t, file);
    await expect(pay("admin", proofFileId)).rejects.toThrow(message);
  });

  it("refuses a proof file that no longer exists", async () => {
    const { harness, programId } = await setup();
    const pay = await path(harness, programId);
    const proofFileId = await storeProofFile(harness.t);
    await harness.t.run((ctx) => ctx.storage.delete(proofFileId));
    await expect(pay("closer", proofFileId)).rejects.toThrow("The proof file wasn't found");
  });
});

describe("a reused proof", () => {
  it("flags the second payment whose file matches one in the tenant", async () => {
    const { harness, programId } = await setup();
    const meeting = await PATHS.meeting(harness, programId);
    const first = await paymentOf(
      harness,
      await meeting("closer", await storeProofFile(harness.t, { contents: "same receipt" })),
    );
    const sideDealPay = await PATHS.sideDeal(harness, programId);
    // Another upload of the same bytes is another file with the same hash.
    const second = await paymentOf(
      harness,
      await sideDealPay("closer", await storeProofFile(harness.t, { contents: "same receipt" })),
    );
    expect(first.proofReused).toBeUndefined();
    expect(second).toMatchObject({ proofReused: true, proofSha256: first.proofSha256 });
  });

  it("accepts a content type with parameters", async () => {
    const { harness, programId } = await setup();
    const meeting = await PATHS.meeting(harness, programId);
    const proofFileId = await storeProofFile(harness.t, { contentType: "IMAGE/JPEG; charset=binary" });
    expect((await paymentOf(harness, await meeting("closer", proofFileId))).proofFileId).toBe(proofFileId);
  });
});

describe("an agent's payment", () => {
  const MCP = { via: "mcp", agentClient: "hermes-agent" } as const;
  const closerOf = (harness: EnrollmentHarness) => ({
    userId: harness.closerId,
    tenantId: harness.tenantId,
    role: "closer" as const,
  });

  it("records how it was entered and the client, on a meeting", async () => {
    const { harness, programId } = await setup();
    const deal = await bookedAndLogged(harness, "agent");
    const proofFileId = await storeProofFile(harness.t);
    const paymentId = await harness.t.run((ctx) =>
      recordMeetingPayment(ctx, closerOf(harness), {
        opportunityId: deal.opportunityId,
        meetingId: deal.meetingId,
        amount: 300,
        currency: "USD",
        programId,
        paymentType: "pif",
        proofFileId,
      }, MCP),
    );
    expect(await paymentOf(harness, paymentId)).toMatchObject({
      recordedVia: "mcp",
      agentClient: "hermes-agent",
      proofFileId,
    });
  });

  it("records how it was entered and the client, on a task", async () => {
    const { harness, programId } = await setup();
    const deal = await bookedAndLogged(harness, "agent-task");
    const followUpId = await harness.t.run((ctx) =>
      ctx.db.insert("followUps", {
        tenantId: harness.tenantId,
        opportunityId: deal.opportunityId,
        leadId: deal.leadId,
        closerId: harness.closerId,
        type: "manual_reminder",
        reason: "closer_initiated",
        status: "pending",
        createdAt: 0,
      }),
    );
    const proofFileId = await storeProofFile(harness.t);
    const paymentId = await harness.t.run((ctx) =>
      recordTaskPayment(ctx, closerOf(harness), {
        followUpId,
        amount: 300,
        currency: "USD",
        programId,
        paymentType: "pif",
        proofFileId,
      }, MCP),
    );
    expect(await paymentOf(harness, paymentId)).toMatchObject({
      recordedVia: "mcp",
      agentClient: "hermes-agent",
      proofFileId,
    });
  });

  it("needs proof, which the preview can skip", async () => {
    const { harness, programId } = await setup();
    const deal = await bookedAndLogged(harness, "agent-preview");
    const args = {
      opportunityId: deal.opportunityId,
      meetingId: deal.meetingId,
      amount: 300,
      currency: "USD",
      programId,
      paymentType: "pif" as const,
    };
    const [checked, skipped] = await harness.t.run(async (ctx) => [
      await checkMeetingPaymentAllowed(ctx, closerOf(harness), args),
      await checkMeetingPaymentAllowed(ctx, closerOf(harness), args, { proof: "skip" }),
    ]);
    expect(checked).toEqual({ ok: false, code: "payment.proof_required", message: PROOF_REQUIRED_MESSAGE });
    expect(skipped).toMatchObject({ ok: true, amountMinor: 30000 });
    await expect(
      harness.t.run((ctx) => recordMeetingPayment(ctx, closerOf(harness), args, MCP)),
    ).rejects.toThrow(PROOF_REQUIRED_MESSAGE);
  });
});

describe("Billing's markers", () => {
  it("shows the agent's client and the payments that share a proof, from either side", async () => {
    const { harness, programId } = await setup();
    await harness.t.run((ctx) => ctx.db.patch("tenants", harness.tenantId, { billingOpsEnabled: true }));
    const meeting = await PATHS.meeting(harness, programId);
    const first = (await meeting(
      "closer",
      await storeProofFile(harness.t, { contents: "shared" }),
    )) as Id<"paymentRecords">;
    const { opportunityId } = await sideDeal(harness, "side-agent", { email: "agent@example.com" });
    const proofFileId = await storeProofFile(harness.t, { contents: "shared" });
    const { paymentId: second } = await harness.closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId, amount: 20, currency: "USD", programId, paymentType: "pif", proofFileId,
    });
    // The side-deal path has no agent core, so the test stamps this payment
    // as an agent's to read the marker back.
    await harness.t.run((ctx) =>
      ctx.db.patch("paymentRecords", second, { recordedVia: "mcp", agentClient: "claude-ai" }),
    );

    const list = await harness.admin.query(api.billing.queries.listPayments, {
      status: "recorded",
      paginationOpts: { numItems: 10, cursor: null },
    });
    const byId = new Map(list.page.map((row) => [row.payment.id, row.payment]));
    expect(byId.get(second)).toMatchObject({ recordedVia: "mcp", agentClient: "claude-ai", proofReused: true });
    expect(byId.get(first)).toMatchObject({ recordedVia: "web", agentClient: null, proofReused: false });

    const secondDetail = await harness.admin.query(api.billing.queries.getPaymentDetail, { paymentRecordId: second });
    expect(secondDetail?.proofMatches.map((match) => match.id)).toEqual([first]);
    const firstDetail = await harness.admin.query(api.billing.queries.getPaymentDetail, { paymentRecordId: first });
    expect(firstDetail?.proofMatches.map((match) => match.id)).toEqual([second]);
  });
});
