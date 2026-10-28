import { convexTest } from "convex-test";
import { describe, it } from "vitest";
import { api } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { expectSameAnswer, rowFromDoc } from "../../../tests/analyticsParity";

const DAY = 24 * 60 * 60 * 1000;
const from = Date.UTC(2026, 8, 1, 6);
const to = Date.UTC(2026, 9, 1, 6);
const range = {
  startDate: "2026-09-01",
  endDateInclusive: "2026-09-30",
  fromMs: from,
  toMs: to,
  timeZone: "America/Tegucigalpa",
  dayStartHour: 0,
};

async function createFixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  const fixture = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0,
      companyName: "Tenant",
      contactEmail: "tenant@example.invalid",
      workosOrgId: "org_a",
      status: "active",
      inviteExpiresAt: Date.now() + DAY,
      createdBy: "test",
    });
    const user = (workosUserId: string, role: Doc<"users">["role"], fullName: string) =>
      ctx.db.insert("users", { tenantId, workosUserId, email: `${workosUserId}@example.invalid`, role, fullName, isActive: true });
    const adminId = await user("admin_a", "tenant_admin", "Ana Admin");
    const closerOne = await user("closer_1", "closer", "Carla Closer");
    const closerTwo = await user("closer_2", "closer", "Beto Closer");
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId,
      name: "Mentorship",
      normalizedName: "mentorship",
      createdAt: from,
      updatedAt: from,
      createdByUserId: adminId,
    });
    const pay = (fields: Partial<Doc<"paymentRecords">>) =>
      ctx.db.insert("paymentRecords", {
        tenantId,
        amountMinor: 100_000,
        currency: "USD",
        recordedByUserId: adminId,
        programId,
        programName: "Mentorship",
        paymentType: "pif",
        status: "verified",
        recordedAt: from + DAY,
        origin: "closer_meeting",
        ...fields,
      });
    await pay({ attributedCloserId: closerOne, amountMinor: 250_000 });
    await pay({ attributedCloserId: closerTwo, paymentType: "deposit", amountMinor: 50_000, recordedAt: from + 3 * DAY });
    await pay({ attributedCloserId: closerTwo, paymentType: "split", amountMinor: 1_200_000, recordedAt: from + 9 * DAY, note: "kept out of the view" });
    await pay({ attributedCloserId: closerOne, status: "disputed", recordedAt: from + 2 * DAY });
    await pay({ attributedCloserId: closerOne, recordedAt: to + DAY });
    // What the report's SQL selects: in range, not disputed.
    const payments = (await ctx.db.query("paymentRecords").take(100)).filter(
      (payment) => payment.recordedAt >= from && payment.recordedAt < to && payment.status !== "disputed",
    );
    return { tenantId, programId, payments };
  });
  return { t, ...fixture, rows: { payments: fixture.payments.map((doc) => rowFromDoc("paymentRecords", doc)) } };
}

const identity = { subject: "admin_a", org_id: "org_a" };

describe("Revenue from ClickHouse rows", () => {
  it("matches every Convex reader on the page", async () => {
    const fixture = await createFixture();
    const base = { t: fixture.t, identity, tenantId: fixture.tenantId, range, rows: fixture.rows };
    const window = { startDate: from, endDate: to };

    await expectSameAnswer({
      ...base,
      reportId: "revenue.metrics",
      live: api.reporting.revenue.getRevenueMetrics,
      liveArgs: window,
      filters: { programId: null, paymentType: null },
    });
    await expectSameAnswer({
      ...base,
      reportId: "revenue.details",
      live: api.reporting.revenue.getRevenueDetails,
      liveArgs: window,
      filters: { programId: null, paymentType: null },
    });
    await expectSameAnswer({
      ...base,
      reportId: "revenue.trend",
      live: api.reporting.revenueTrend.getRevenueTrend,
      liveArgs: { ...window, granularity: "week" },
      filters: { programId: null, paymentType: null, granularity: "week" },
    });
    await expectSameAnswer({
      ...base,
      reportId: "revenue.booked_vs_sold",
      live: api.reporting.bookedVsSold.getBookedVsSoldMatrix,
      liveArgs: window,
      filters: { programId: null, paymentType: null },
    });
  });

  it("applies the program and payment type filters the same way", async () => {
    const fixture = await createFixture();
    await expectSameAnswer({
      t: fixture.t,
      identity,
      tenantId: fixture.tenantId,
      range,
      rows: fixture.rows,
      reportId: "revenue.metrics",
      live: api.reporting.revenue.getRevenueMetrics,
      liveArgs: { startDate: from, endDate: to, programId: fixture.programId, paymentType: "deposit" },
      filters: { programId: fixture.programId, paymentType: "deposit" },
    });
  });
});
