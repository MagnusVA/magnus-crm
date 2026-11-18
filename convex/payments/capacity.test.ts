import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { stageOfPosition } from "../opportunities/stages";
import { FIXTURE_PAID_AT, providerPaymentFixture } from "../../tests/providerPaymentFixtures";
import {
  DEALS_PER_PERSON_HOLD,
  PAYMENT_ROWS_PER_DEAL_HOLD,
  checkPaymentCapacity,
} from "./capacity";

type Harness = Awaited<ReturnType<typeof providerPaymentFixture>>;

async function insertRows(ctx: MutationCtx, h: Harness, count: number, status: "recorded" | "disputed") {
  for (let index = 0; index < count; index += 1) {
    await ctx.db.insert("paymentRecords", {
      tenantId: h.tenantId, opportunityId: h.dealId!, attributedCloserId: h.closerId, amountMinor: 100, currency: "USD",
      recordedByUserId: h.adminId, programId: h.programId, programName: "Sales training", paymentType: "split",
      status, recordedAt: FIXTURE_PAID_AT + index, origin: "closer_additional",
    });
  }
}

async function insertDeals(ctx: MutationCtx, h: Harness, count: number) {
  for (let index = 0; index < count; index += 1) {
    await ctx.db.insert("opportunities", {
      ...stageOfPosition("lost"), source: "calendly", lostReason: "stale", tenantId: h.tenantId, leadId: h.personId,
      createdAt: FIXTURE_PAID_AT + index, updatedAt: FIXTURE_PAID_AT + index,
    });
  }
}

const check = (h: Harness) =>
  h.t.run((ctx) => checkPaymentCapacity(ctx, { opportunityId: h.dealId!, leadId: h.personId }));

describe("checkPaymentCapacity", () => {
  it("holds at 40 rows on a deal and 100 deals for a person", () => {
    expect([PAYMENT_ROWS_PER_DEAL_HOLD, DEALS_PER_PERSON_HOLD]).toEqual([40, 100]);
  });

  it("lets the 40th row in and holds the 41st", async () => {
    const h = await providerPaymentFixture();
    await h.t.run((ctx) => insertRows(ctx, h, 39, "recorded"));
    expect(await check(h)).toEqual({ ok: true });
    await h.t.run((ctx) => insertRows(ctx, h, 1, "recorded"));
    expect(await check(h)).toEqual({ ok: false, code: "capacity_hold", bound: "deal_payments" });
  });

  it("counts disputed rows", async () => {
    const h = await providerPaymentFixture();
    await h.t.run(async (ctx) => {
      await insertRows(ctx, h, 20, "recorded");
      await insertRows(ctx, h, 20, "disputed");
    });
    expect(await check(h)).toEqual({ ok: false, code: "capacity_hold", bound: "deal_payments" });
  });

  it("lets a person's 99th deal take a payment and holds at 100", async () => {
    const h = await providerPaymentFixture();
    // The fixture's deal is the first.
    await h.t.run((ctx) => insertDeals(ctx, h, 98));
    expect(await check(h)).toEqual({ ok: true });
    await h.t.run((ctx) => insertDeals(ctx, h, 1));
    expect(await check(h)).toEqual({ ok: false, code: "capacity_hold", bound: "person_deals" });
  });

  it("throws for a deal that doesn't exist", async () => {
    const h = await providerPaymentFixture();
    const dealId = h.dealId!;
    await h.t.run(async (ctx) => { await ctx.db.delete("opportunities", dealId); });
    await expect(h.t.run((ctx) => checkPaymentCapacity(ctx, {
      opportunityId: dealId as Id<"opportunities">, leadId: h.personId,
    }))).rejects.toThrow("not found");
  });
});
