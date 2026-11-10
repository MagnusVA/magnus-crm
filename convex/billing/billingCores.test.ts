import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import {
  book,
  enrollmentHarness,
  twoPrograms,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";
import { dumpTables, writtenRows } from "../../tests/writeDump";
import {
  checkCorrectPaymentAllowed,
  checkMarkReviewedAllowed,
  correctPaymentCore,
  describeCorrectionEffects,
  markReviewedCore,
} from "./mutations";

// `markReviewed` and `correctPayment` split into a guard and a core (admin
// assistant, commit 7). These snapshots were taken on the handlers before the
// split: each web path must write the same rows, aggregates, enrollments and
// events after it, and refuse with the same message.

afterEach(() => vi.useRealTimers());

const CALL_LOGGED = Date.parse("2026-10-01T12:40:00Z");

async function paidDeal(harness: EnrollmentHarness) {
  const programs = await twoPrograms(harness);
  const deal = await book(harness, "billing-parity");
  vi.setSystemTime(new Date(CALL_LOGGED));
  await harness.admin.mutation(api.closer.payments.logPayment, {
    opportunityId: deal.opportunityId,
    meetingId: deal.meetingId,
    amount: 1000,
    currency: "USD",
    programId: programs.programA,
    paymentType: "pif",
  });
  await harness.t.run((ctx) => ctx.db.patch("tenants", harness.tenantId, { billingOpsEnabled: true }));
  const paymentRecordId = await harness.t.run(async (ctx) =>
    (await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", deal.opportunityId))
      .first())!._id,
  );
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.setSystemTime(new Date(CALL_LOGGED + 60_000));
  return { ...deal, ...programs, paymentRecordId };
}

async function writes(harness: EnrollmentHarness, write: () => Promise<unknown>) {
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  const before = await dumpTables(harness.t);
  const result = await write();
  const after = await dumpTables(harness.t);
  return { result, written: writtenRows(before, after) };
}

describe("web paths write what they wrote before the split", () => {
  it("markReviewed", async () => {
    const harness = await enrollmentHarness();
    const deal = await paidDeal(harness);
    const { written, result } = await writes(harness, () =>
      harness.admin.mutation(api.billing.mutations.markReviewed, {
        paymentRecordId: deal.paymentRecordId,
      }),
    );
    expect({ result, written }).toMatchSnapshot();
  });

  it("markReviewed, already reviewed", async () => {
    const harness = await enrollmentHarness();
    const deal = await paidDeal(harness);
    await harness.admin.mutation(api.billing.mutations.markReviewed, {
      paymentRecordId: deal.paymentRecordId,
    });
    const { written, result } = await writes(harness, () =>
      harness.admin.mutation(api.billing.mutations.markReviewed, {
        paymentRecordId: deal.paymentRecordId,
      }),
    );
    expect({ result, written }).toMatchSnapshot();
  });

  it("correctPayment, program and amount on a reviewed payment", async () => {
    const harness = await enrollmentHarness();
    const deal = await paidDeal(harness);
    await harness.admin.mutation(api.billing.mutations.markReviewed, {
      paymentRecordId: deal.paymentRecordId,
    });
    const { written, result } = await writes(harness, () =>
      harness.admin.mutation(api.billing.mutations.correctPayment, {
        paymentRecordId: deal.paymentRecordId,
        amount: 750.25,
        programId: deal.programB,
        reason: "  Wrong program  ",
      }),
    );
    expect({ result, written }).toMatchSnapshot();
  });

  it("correctPayment, note and reference only", async () => {
    const harness = await enrollmentHarness();
    const deal = await paidDeal(harness);
    const { written, result } = await writes(harness, () =>
      harness.admin.mutation(api.billing.mutations.correctPayment, {
        paymentRecordId: deal.paymentRecordId,
        referenceCode: " INV-7 ",
        note: "Paid by wire",
        reason: "Add the invoice",
      }),
    );
    expect({ result, written }).toMatchSnapshot();
  });

  it("correctPayment, nothing changed", async () => {
    const harness = await enrollmentHarness();
    const deal = await paidDeal(harness);
    const { written, result } = await writes(harness, () =>
      harness.admin.mutation(api.billing.mutations.correctPayment, {
        paymentRecordId: deal.paymentRecordId,
        amount: 1000,
        reason: "Check",
      }),
    );
    expect({ result, written }).toMatchSnapshot();
  });

  it("refuses with the same messages", async () => {
    const harness = await enrollmentHarness();
    const deal = await paidDeal(harness);
    const refusals: Record<string, string> = {};
    const refusal = async (name: string, write: () => Promise<unknown>) => {
      try {
        await write();
        refusals[name] = "allowed";
      } catch (error) {
        refusals[name] = (error as Error).message;
      }
    };
    await refusal("closer reviews", () =>
      harness.closer.mutation(api.billing.mutations.markReviewed, {
        paymentRecordId: deal.paymentRecordId,
      }),
    );
    await refusal("blank reason", () =>
      harness.admin.mutation(api.billing.mutations.correctPayment, {
        paymentRecordId: deal.paymentRecordId,
        amount: 5,
        reason: "   ",
      }),
    );
    await harness.t.run((ctx) =>
      ctx.db.patch("paymentRecords", deal.paymentRecordId, { status: "disputed" }),
    );
    await refusal("review a disputed payment", () =>
      harness.admin.mutation(api.billing.mutations.markReviewed, {
        paymentRecordId: deal.paymentRecordId,
      }),
    );
    await refusal("correct a disputed payment", () =>
      harness.admin.mutation(api.billing.mutations.correctPayment, {
        paymentRecordId: deal.paymentRecordId,
        amount: 5,
        reason: "Fix",
      }),
    );
    await harness.t.run((ctx) =>
      ctx.db.patch("tenants", harness.tenantId, { billingOpsEnabled: false }),
    );
    await refusal("Billing Ops off", () =>
      harness.admin.mutation(api.billing.mutations.markReviewed, {
        paymentRecordId: deal.paymentRecordId,
      }),
    );
    expect(refusals).toMatchSnapshot();
  });
});

const MCP = { via: "mcp", agentClient: "claude-ai" } as const;
const TAG = ',"via":"mcp","agentClient":"claude-ai"';

function actor(harness: EnrollmentHarness) {
  return { userId: harness.adminId, tenantId: harness.tenantId, role: "tenant_admin" as const };
}

/** The rows with the agent's tag taken out of event metadata. */
function untag(written: unknown) {
  return JSON.parse(JSON.stringify(written).replaceAll(TAG, "")) as unknown;
}

async function eventMetadata(harness: EnrollmentHarness, eventType: string) {
  return await harness.t.run(async (ctx) =>
    (await ctx.db.query("domainEvents").take(200))
      .filter((event) => event.eventType === eventType)
      .map((event) => JSON.parse(event.metadata ?? "{}") as Record<string, unknown>),
  );
}

describe("an agent's write through a core", () => {
  it("markReviewedCore writes the web's rows and tags payment.verified", async () => {
    const web = await enrollmentHarness();
    const webDeal = await paidDeal(web);
    const webWrites = await writes(web, () =>
      web.admin.mutation(api.billing.mutations.markReviewed, { paymentRecordId: webDeal.paymentRecordId }),
    );
    vi.useRealTimers();
    const mcp = await enrollmentHarness();
    const mcpDeal = await paidDeal(mcp);
    const mcpWrites = await writes(mcp, () =>
      mcp.t.run((ctx) => markReviewedCore(ctx, actor(mcp), { paymentRecordId: mcpDeal.paymentRecordId }, MCP)),
    );
    expect(untag(mcpWrites.written)).toEqual(webWrites.written);
    expect((await eventMetadata(mcp, "payment.verified"))[0]).toMatchObject({ via: "mcp", agentClient: "claude-ai" });
  });

  it("correctPaymentCore writes the web's rows and tags payment.corrected only", async () => {
    const args = (deal: Awaited<ReturnType<typeof paidDeal>>) => ({
      paymentRecordId: deal.paymentRecordId,
      amount: 750.25,
      programId: deal.programB,
      reason: "Wrong program",
    });
    const web = await enrollmentHarness();
    const webDeal = await paidDeal(web);
    const webWrites = await writes(web, () => web.admin.mutation(api.billing.mutations.correctPayment, args(webDeal)));
    vi.useRealTimers();
    const mcp = await enrollmentHarness();
    const mcpDeal = await paidDeal(mcp);
    const mcpWrites = await writes(mcp, () =>
      mcp.t.run((ctx) => correctPaymentCore(ctx, actor(mcp), args(mcpDeal), MCP)),
    );
    expect(mcpWrites.result).toEqual(webWrites.result);
    expect(untag(mcpWrites.written)).toEqual(webWrites.written);
    expect((await eventMetadata(mcp, "payment.corrected"))[0]).toMatchObject({ via: "mcp", agentClient: "claude-ai" });
    expect(JSON.stringify(mcpWrites.written).split(TAG)).toHaveLength(2);
  });

  it("refuses a closer, a missing permission switch and Billing Ops off", async () => {
    const harness = await enrollmentHarness();
    const deal = await paidDeal(harness);
    await expect(
      harness.t.run((ctx) =>
        markReviewedCore(ctx, { ...actor(harness), role: "closer" }, { paymentRecordId: deal.paymentRecordId }, MCP),
      ),
    ).rejects.toThrow("This action isn't available for your role.");
    await harness.t.run((ctx) => ctx.db.patch("tenants", harness.tenantId, { billingOpsEnabled: false }));
    await expect(
      harness.t.run((ctx) => markReviewedCore(ctx, actor(harness), { paymentRecordId: deal.paymentRecordId }, MCP)),
    ).rejects.toThrow("Billing Ops is not enabled for this tenant.");
    expect(
      await harness.t.run((ctx) =>
        checkMarkReviewedAllowed(ctx, actor(harness), { paymentRecordId: deal.paymentRecordId }),
      ),
    ).toEqual({ ok: false, code: "billing.ops_disabled", message: "Billing Ops is not enabled for this tenant." });
  });
});

describe("checks and the effect description", () => {
  it("check without writing, and return the core's refusal", async () => {
    const harness = await enrollmentHarness();
    const deal = await paidDeal(harness);
    const before = await dumpTables(harness.t);
    expect(
      await harness.t.run((ctx) =>
        checkMarkReviewedAllowed(ctx, actor(harness), { paymentRecordId: deal.paymentRecordId }),
      ),
    ).toEqual({ ok: true, paymentRecordId: deal.paymentRecordId, status: "recorded", alreadyReviewed: false });
    expect(
      await harness.t.run((ctx) =>
        checkCorrectPaymentAllowed(ctx, actor(harness), {
          paymentRecordId: deal.paymentRecordId,
          amount: 5,
          reason: "  ",
        }),
      ),
    ).toEqual({ ok: false, code: "outcome.refused", message: "A correction reason is required." });
    expect(
      await harness.t.run((ctx) =>
        checkCorrectPaymentAllowed(ctx, actor(harness), {
          paymentRecordId: deal.paymentRecordId,
          paymentType: "deposit",
          reason: "Type",
        }),
      ),
    ).toMatchObject({ ok: true, changed: true, changedKeys: ["paymentType"], returnedToReview: false });
    expect(writtenRows(before, await dumpTables(harness.t))).toEqual({});
  });

  it("describes a correction the same way twice, without writing", async () => {
    const harness = await enrollmentHarness();
    const deal = await paidDeal(harness);
    await harness.admin.mutation(api.billing.mutations.markReviewed, { paymentRecordId: deal.paymentRecordId });
    const args = {
      paymentRecordId: deal.paymentRecordId,
      amount: 750.25,
      programId: deal.programB,
      referenceCode: "INV-9",
      reason: "Wrong program",
    };
    const before = await dumpTables(harness.t);
    const first = await harness.t.run((ctx) => describeCorrectionEffects(ctx, actor(harness), args));
    const second = await harness.t.run((ctx) => describeCorrectionEffects(ctx, actor(harness), args));
    expect(writtenRows(before, await dumpTables(harness.t))).toEqual({});
    expect(second).toEqual(first);
    expect(first).toEqual([
      "Amount: $1,000.00 → $750.25.",
      "Program: Program A → Program B.",
      "Reference code: added.",
      "Review: the payment goes back to Needs review; its reviewed mark is removed.",
      "Enrollments: the person's enrollments are re-derived from their payments, with this payment counting toward Program B instead of Program A.",
    ]);
    expect(
      await harness.t.run((ctx) =>
        describeCorrectionEffects(ctx, actor(harness), {
          paymentRecordId: deal.paymentRecordId,
          amount: 1000,
          reason: "Same",
        }),
      ),
    ).toEqual(["Nothing changes: every field already has this value."]);
  });
});
