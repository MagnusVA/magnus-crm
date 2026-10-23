import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { paymentOriginHarness } from "../tests/paymentOriginFixtures";
import { writePersonEnrollments } from "./lib/enrollments";
import { paymentSums } from "./reporting/aggregates";
import { insertPaymentAggregate, replacePaymentAggregate } from "./reporting/writeHooks";
import { normalizePaymentOrigin } from "./lib/paymentTypes";

afterEach(() => vi.useRealTimers());

describe("assertPaymentsCommissionable", () => {
  it("accepts true and cleared rows at all four live origins without changing them", async () => {
    const h = await paymentOriginHarness();
    await h.t.run(async (ctx) => {
      for (const origin of ["closer_meeting", "closer_side_deal", "closer_additional", "closer_reminder"] as const) {
        await ctx.db.insert("paymentRecords", { ...h.payment, origin, commissionable: true });
        await ctx.db.insert("paymentRecords", { ...h.payment, origin });
      }
    });
    const before = await h.t.run((ctx) => ctx.db.query("paymentRecords").take(20));
    expect((await h.run("assertPaymentsCommissionable"))?.error).toBeUndefined();
    expect((await h.run("assertPaymentsCommissionable", true))?.error).toBeUndefined();
    expect(await h.t.run((ctx) => ctx.db.query("paymentRecords").take(20))).toEqual(before);
  });

  it("rejects false with the payment ID only", async () => {
    const h = await paymentOriginHarness();
    const id = await h.t.run((ctx) => ctx.db.insert("paymentRecords", { ...h.payment, commissionable: false }));
    expect((await h.run("assertPaymentsCommissionable"))?.error).toBe(`Payment ${id}`);
  });

  it.each(["customer_direct", "bookkeeper_direct"])("rejects a retired origin: %s", async (origin) => {
    const h = await paymentOriginHarness(true);
    const id = await h.t.run((ctx) => ctx.db.insert("paymentRecords", {
      ...h.payment, commissionable: true, origin: origin as Doc<"paymentRecords">["origin"],
    }));
    expect((await h.run("assertPaymentsCommissionable"))?.error).toBe(`Payment ${id}`);
  });
});

describe("clearPaymentCommissionable", () => {
  it("rolls back a dry run without changing stored payments", async () => {
    const h = await paymentOriginHarness();
    const id = await h.t.run((ctx) => ctx.db.insert("paymentRecords", {
      ...h.payment, commissionable: true,
    }));
    const before = await h.t.run((ctx) => ctx.db.get("paymentRecords", id));
    await expect(h.t.mutation(internal.migrations.clearPaymentCommissionable, {
      cursor: null, dryRun: true,
    })).resolves.toMatchObject({ DryRun: "No changes were committed." });
    expect(await h.t.run((ctx) => ctx.db.get("paymentRecords", id))).toEqual(before);
  });

  it("counts payments and attributes their aggregate keys independently of the retired field", async () => {
    const h = await paymentOriginHarness();
    await h.t.run(async (ctx) => {
      for (const fields of [
        { commissionable: true, amountMinor: 10_000 },
        { commissionable: false, amountMinor: 2_500, paymentType: "deposit" as const },
        { amountMinor: 3_000 },
        { commissionable: false, amountMinor: 99, status: "disputed" as const },
      ]) {
        const id = await ctx.db.insert("paymentRecords", { ...h.payment, ...fields });
        await insertPaymentAggregate(ctx, id);
      }
    });
    expect(await h.admin.query(api.reporting.revenue.getRevenueMetrics, {
      startDate: 0, endDate: 2000,
    })).toMatchObject({ revenue: {
      finalRevenueMinor: 13_000, depositRevenueMinor: 2_500, totalDeals: 2,
    } });
    expect(await h.t.run((ctx) => paymentSums.sum(ctx, {
      namespace: h.tenantId, bounds: {
        lower: { key: [h.closerId, 0], inclusive: true },
        upper: { key: [h.closerId, 2000], inclusive: true },
      },
    }))).toBe(15_500);
  });

  it("clears both stored values, leaves absent fields alone and is idempotent", async () => {
    const h = await paymentOriginHarness();
    await h.t.run(async (ctx) => {
      for (const commissionable of [true, false, undefined]) {
        await ctx.db.insert("paymentRecords", { ...h.payment, commissionable });
      }
    });
    const before = await h.t.run((ctx) => ctx.db.query("paymentRecords").take(10));
    expect((await h.run("clearPaymentCommissionable"))?.error).toBeUndefined();
    const after = await h.t.run((ctx) => ctx.db.query("paymentRecords").take(10));
    expect(after).toEqual(before.map(({ commissionable: _removed, ...payment }) => payment));
    expect((await h.run("clearPaymentCommissionable", true))?.error).toBeUndefined();
    expect(await h.t.run((ctx) => ctx.db.query("paymentRecords").take(10))).toEqual(after);
    expect((await h.run("assertPaymentCommissionableCleared"))?.error).toBeUndefined();
  });

  it("preserves reporting, aggregate entries, enrollments and events; hooks and backfill still work", async () => {
    const h = await paymentOriginHarness();
    const paymentId = await h.t.run(async (ctx) => {
      const id = await ctx.db.insert("paymentRecords", { ...h.payment, commissionable: true });
      await insertPaymentAggregate(ctx, id);
      await writePersonEnrollments(ctx, { tenantId: h.tenantId, leadId: h.leadId });
      return id;
    });
    const snapshot = () => h.t.run(async (ctx) => ({
      sum: await paymentSums.sum(ctx, { namespace: h.tenantId }),
      count: await paymentSums.count(ctx, { namespace: h.tenantId }),
      closerSum: await paymentSums.sum(ctx, { namespace: h.tenantId, bounds: {
        lower: { key: [h.closerId, 0], inclusive: true }, upper: { key: [h.closerId, 2000], inclusive: true },
      } }),
      enrollments: await ctx.db.query("enrollments").take(10),
      events: await ctx.db.query("domainEvents").take(10),
    }));
    const filters = { startDate: 0, endDate: 2000 };
    const metrics = await h.admin.query(api.reporting.revenue.getRevenueMetrics, filters);
    const before = await snapshot();
    expect(before).toMatchObject({ sum: 10_000, count: 1, closerSum: 10_000 });
    expect((await h.run("assertPaymentsCommissionable"))?.error).toBeUndefined();
    expect((await h.run("clearPaymentCommissionable"))?.error).toBeUndefined();
    expect((await h.run("assertPaymentCommissionableCleared"))?.error).toBeUndefined();
    expect(await snapshot()).toEqual(before);
    expect(await h.admin.query(api.reporting.revenue.getRevenueMetrics, filters)).toEqual(metrics);
    await h.t.mutation(internal.reporting.backfill.backfillPaymentsAggregate, {});
    expect(await snapshot()).toEqual(before);
    await h.t.run(async (ctx) => {
      const payment = (await ctx.db.get("paymentRecords", paymentId))!;
      await ctx.db.patch("paymentRecords", paymentId, { amountMinor: 15_000 });
      await replacePaymentAggregate(ctx, payment, paymentId);
    });
    expect(await snapshot()).toMatchObject({ sum: 15_000, count: 1, closerSum: 15_000 });
  });
});

describe("assertPaymentCommissionableCleared", () => {
  it.each([true, false])("rejects a field still set to %s and passes after clearing it", async (commissionable) => {
    const h = await paymentOriginHarness();
    const id = await h.t.run((ctx) => ctx.db.insert("paymentRecords", { ...h.payment, commissionable }));
    expect((await h.run("assertPaymentCommissionableCleared"))?.error).toBe(`Payment ${id}`);
    await h.run("clearPaymentCommissionable");
    expect((await h.run("assertPaymentCommissionableCleared", true))?.error).toBeUndefined();
  });

  it("passes for an empty table", async () => {
    const h = await paymentOriginHarness();
    expect((await h.run("assertPaymentCommissionableCleared"))?.error).toBeUndefined();
  });
});

it("normalizes the legacy customer flow to a meeting payment", () => {
  expect(normalizePaymentOrigin("customer_flow")).toBe("closer_meeting");
});
