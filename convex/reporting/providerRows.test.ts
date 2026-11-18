import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import { DAY, insertDeal, insertEnrollment } from "../../tests/enrollmentReadFixtures";
import { FIXTURE_PAID_AT, providerPaymentFixture } from "../../tests/providerPaymentFixtures";
import { seedProviderRow } from "../../tests/providerRowFixtures";
import { expectMergedAnswer } from "../../tests/analyticsMerge";
import { mergeRevenueMetrics } from "../analytics/merge/revenue";
import { insertPaymentAggregate } from "./writeHooks";

const depositAt = FIXTURE_PAID_AT;
const installmentAt = depositAt + DAY;
const window = { startDate: depositAt, endDate: installmentAt + DAY };

describe("provider payment report readers", () => {
  it.each(["confirmed", "automatic"] as const)("counts %s payments at recordedAt", async (entry) => {
    const f = await providerPaymentFixture({ dealStatus: null });
    await f.t.run(async (ctx) => {
      // An unassigned won deal needs payment credit to appear in Lead Conversion.
      const opportunityId = await insertDeal(ctx, { tenantId: f.tenantId, leadId: f.personId });
      const base = {
        tenantId: f.tenantId,
        opportunityId,
        closerId: f.closerId,
        programId: f.programId,
        programName: "Sales training",
        recorder: entry === "confirmed" ? f.adminId : "absent" as const,
        providerPaidAt: depositAt - DAY,
      };
      await seedProviderRow(ctx, { ...base, amountMinor: 5_000, paymentType: "deposit", recordedAt: depositAt });
      await seedProviderRow(ctx, { ...base, amountMinor: 25_000, paymentType: "split", recordedAt: installmentAt });
      await seedProviderRow(ctx, { ...base, amountMinor: 99_999, recordedAt: installmentAt, status: "disputed" });
      await insertEnrollment(ctx, {
        tenantId: f.tenantId,
        leadId: f.personId,
        opportunityId,
        programId: f.programId,
        enrolledAt: depositAt,
      });
      const manual = await ctx.db.insert("paymentRecords", {
        tenantId: f.tenantId,
        opportunityId,
        attributedCloserId: f.closerId,
        recordedByUserId: f.adminId,
        amountMinor: 15_000,
        currency: "USD",
        programId: f.programId,
        programName: "Sales training",
        paymentType: "monthly",
        status: "verified",
        origin: "admin_additional",
        recordedVia: "web",
        recordedAt: installmentAt + 1,
        providerPaymentId: f.providerPaymentId,
        providerPaidAt: depositAt - DAY,
      });
      await insertPaymentAggregate(ctx, manual);
    });

    const { history, whole } = await expectMergedAnswer({
      t: f.t,
      identity: { subject: "user_admin", org_id: "org_test" },
      live: api.reporting.revenue.getRevenueMetrics,
      history: { startDate: depositAt, endDate: installmentAt },
      today: { startDate: installmentAt, endDate: window.endDate },
      whole: window,
      merge: mergeRevenueMetrics,
    });
    expect(history.revenue).toMatchObject({ depositRevenueMinor: 5_000, finalRevenueMinor: 0, totalDeals: 0 });
    expect(whole).toMatchObject({
      revenue: {
        finalRevenueMinor: 40_000,
        depositRevenueMinor: 5_000,
        totalDeals: 2,
        avgDealMinor: 20_000,
        byOrigin: { provider: 25_000, admin_additional: 15_000 },
        byCloser: [{ closerId: f.closerId, revenueMinor: 40_000, dealCount: 2 }],
        byProgram: [{ programId: f.programId, paymentCount: 3 }],
      },
      byPaymentType: { deposit: 5_000, split: 25_000, monthly: 15_000, pif: 0 },
    });

    const team = await f.admin.query(api.reporting.teamPerformance.getTeamPerformanceMetrics, window);
    expect(team.closers).toMatchObject([
      { closerId: f.closerId, cashCollectedMinor: 40_000, sales: 2, adminLoggedRevenueMinor: 15_000 },
    ]);
    expect(team.teamTotals.totalAdminLoggedRevenueMinor).toBe(15_000);

    const conversion = await f.admin.query(api.reporting.leadConversion.getLeadConversionMetrics, window);
    expect(conversion).toMatchObject({
      totalConversions: 1,
      excludedConversions: 0,
      byCloser: [{ closerId: f.closerId, conversions: 1 }],
    });

    const audit = await f.t.query(internal.reporting.backfill.auditPaymentOriginBackfill, {});
    expect(audit).toMatchObject({
      total: 4,
      withOrigin: 4,
      adminAttributed: 1,
      byOrigin: { provider: 3, admin_additional: 1 },
    });
  });
});
