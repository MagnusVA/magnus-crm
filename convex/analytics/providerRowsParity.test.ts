import { beforeAll, describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import { fixtureUsers, insertPerson, insertProgram } from "../../tests/enrollmentReadFixtures";
import { expectSameAnswer, rowFromDoc } from "../../tests/analyticsParity";
import { closerAggregateRows } from "../../tests/peopleClosersAggregateFixtures";
import { roleAggregateRows } from "../../tests/peopleRolesAggregateFixtures";
import { seedProviderRow } from "../../tests/providerRowFixtures";
import { resolveAnalyticsRange } from "../../lib/analyticsRange";
import { DEFAULT_BUSINESS_DAY } from "../../lib/businessDay";
import { docFromRow } from "./rows";
import type { ApiMetricsAnswer } from "./api/metrics";

const range = resolveAnalyticsRange({
  kind: "custom", startDate: "2026-11-16", endDateInclusive: "2026-11-17",
}, DEFAULT_BUSINESS_DAY, 0);
const DAY = 86_400_000;
const depositAt = range.fromMs + 1;
const installmentAt = depositAt + DAY;
const now = range.toMs + DAY;
const identity = { subject: "user_admin", org_id: "org_test" };
const liveArgs = { startDate: range.fromMs, endDate: range.toMs };
const metricNames = "average_deal_size,cash_collected,deposits";

async function fixture(confirmed: boolean) {
  const { t, tenantId, admin } = await bookingHarness({ transactionLimits: true });
  const rows = await t.run(async (ctx) => {
    const users = await fixtureUsers(ctx, tenantId);
    const closerId = users.closer._id;
    const adminId = users.admin._id;
    const programId = await insertProgram(ctx, tenantId, adminId, "Sales training");
    const leadId = await insertPerson(ctx, tenantId);
    const memberId = await ctx.db.insert("teamMembers", {
      tenantId, displayName: "Credited closer", createdAt: 0, updatedAt: 0,
    });
    const setterId = await ctx.db.insert("teamMembers", {
      tenantId, displayName: "Credited setter", createdAt: 0, updatedAt: 0,
    });
    await ctx.db.patch("users", closerId, { teamMemberId: memberId });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId, leadId, assignedCloserId: closerId, stage: "closed", outcome: "won",
      createdAt: range.fromMs, updatedAt: depositAt, paymentReceivedAt: depositAt,
    });
    const attributionId = await ctx.db.insert("dealAttributions", {
      tenantId, opportunityId, role: "setter", teamMemberId: setterId,
      attributedAt: range.fromMs, createdAt: range.fromMs,
      source: { kind: "slack_qualification", slackUserId: "U_TEST" },
    });
    const base = {
      tenantId, closerId, opportunityId, programId, programName: "Sales training",
      recorder: confirmed ? adminId : "absent" as const,
      providerPaidAt: range.fromMs - DAY,
    };
    const depositId = await seedProviderRow(ctx, {
      ...base, amountMinor: 5_000, paymentType: "deposit", recordedAt: depositAt,
    });
    const installmentId = await seedProviderRow(ctx, {
      ...base, amountMinor: 25_000, paymentType: "split", recordedAt: installmentAt, status: "verified",
    });
    const disputedId = await seedProviderRow(ctx, {
      ...base, amountMinor: 99_999, recordedAt: installmentAt + 1, status: "disputed",
    });
    const paymentIds = [depositId, installmentId, disputedId];
    const paymentRows = await Promise.all(paymentIds.map(async (id) => {
      const doc = (await ctx.db.get("paymentRecords", id))!;
      const { providerPaidAt: _providerPaidAt, ...viewFields } = doc;
      void _providerPaidAt;
      return {
        ...rowFromDoc("paymentRecords", viewFields),
        recorded_by_user_id: doc.recordedByUserId ?? null,
      };
    }));
    return {
      adminId, closerId, memberId, setterId, paymentIds, paymentRows,
      deals: [rowFromDoc("opportunities", (await ctx.db.get("opportunities", opportunityId))!)],
      attributions: [rowFromDoc("dealAttributions", (await ctx.db.get("dealAttributions", attributionId))!)],
    };
  });
  return { t, tenantId, admin, ...rows };
}

beforeAll(async () => {
  // Keep the report modules' cold-load time out of the cases.
  await Promise.all([
    import("./results"),
    import("./api/queries"),
    import("../reports/people"),
    import("../reports/peopleRoles"),
  ]);
}, 45_000);

describe("warehouse parity for provider payment rows", () => {
  it.each([true, false])("matches live for provider payments with recorder present = %s", async (confirmed) => {
    const f = await fixture(confirmed);
    for (const row of f.paymentRows) {
      const doc = docFromRow<"paymentRecords">(row);
      expect(doc).toMatchObject({ origin: "provider", recordedVia: "provider", attributedCloserId: f.closerId });
      if (confirmed) expect(doc.recordedByUserId).toBe(f.adminId);
      else expect(doc).not.toHaveProperty("recordedByUserId");
    }
    const payments = f.paymentRows.filter(row => docFromRow<"paymentRecords">(row).status !== "disputed");
    const shared = { t: f.t, tenantId: f.tenantId, identity, range };
    const revenue = await expectSameAnswer({
      ...shared, reportId: "revenue.metrics", live: api.reporting.revenue.getRevenueMetrics,
      liveArgs, filters: { programId: null, paymentType: null }, rows: { payments },
    });
    expect(revenue.revenue).toMatchObject({
      byOrigin: { provider: 25_000 }, finalRevenueMinor: 25_000, depositRevenueMinor: 5_000, totalDeals: 1,
    });

    const scorecard = await expectSameAnswer({
      ...shared, reportId: "scorecard.cash", live: api.reports.scorecard.cash,
      liveArgs: { range }, filters: { programId: null },
      rows: { payments: f.paymentRows, deals: f.deals },
    });
    expect(scorecard.currencies).toMatchObject([
      { currency: "USD", cashMinor: 30_000, finalMinor: 25_000, depositMinor: 5_000, dealsWon: 1, byProgram: [{ payments: 2 }] },
    ]);

    const attribution = await expectSameAnswer({
      ...shared, reportId: "attribution.lanes", live: api.reports.attribution.getLanes,
      liveArgs, filters: {}, rows: { payments, attributions: f.attributions },
    });
    expect(attribution.totals).toEqual([{ currency: "USD", cashMinor: 30_000, finalMinor: 25_000, payments: 2 }]);
    for (const [role, teamMemberId] of [["closer", f.memberId], ["setter", f.setterId]] as const) {
      expect(attribution.lanes.find((lane: { role: string }) => lane.role === role)?.people).toMatchObject([
        { teamMemberId, byCurrency: [{ currency: "USD", amountMinor: 30_000 }] },
      ]);
    }

    const people = await expectSameAnswer({
      ...shared, reportId: "people.closers", live: api.reports.people.getPeopleClosers,
      liveArgs, filters: { memberId: null }, rows: await closerAggregateRows(f.t, f.tenantId, null, range),
    });
    expect(people.rows).toMatchObject([
      { userId: f.closerId, payments: 2, dealsWon: 1, cash: [{ currency: "USD", cashMinor: 30_000, finalMinor: 25_000 }] },
    ]);

    const setters = await expectSameAnswer({
      ...shared, reportId: "people.setters", live: api.reports.peopleRoles.getSetters,
      liveArgs, filters: { memberId: null },
      rows: await roleAggregateRows(f.t, f.tenantId, "setter", null, range, now),
    });
    expect(setters.rows).toMatchObject([
      { teamMemberId: f.setterId, byCurrency: [{ currency: "USD", amountMinor: 30_000 }] },
    ]);

    const readMetrics = () => f.t.query(internal.analytics.api.queries.liveMetricsForWindow, {
      tenantId: f.tenantId, metrics: metricNames, granularity: "day", groupBy: "closer",
      fromMs: range.fromMs, toMs: range.toMs, timeZone: range.timeZone, dayStartHour: range.dayStartHour,
    });
    const liveMetrics = await readMetrics();
    const apiWarehouse = await f.t.query(internal.analytics.results.previewFinalize, {
      reportId: "api.metrics", tenantId: f.tenantId, range,
      filtersJson: JSON.stringify({ metrics: metricNames, granularity: "day", group_by: "closer" }),
      rowsJson: JSON.stringify({ payments: [
        { period: range.startDate, group_id: f.memberId, currency: "USD", cash_collected: 5_000, deposits: 5_000, final_cash: 0, final_count: 0 },
        { period: range.endDateInclusive, group_id: f.memberId, currency: "USD", cash_collected: 25_000, deposits: 0, final_cash: 25_000, final_count: 1 },
      ] }),
    });
    const metrics: ApiMetricsAnswer = JSON.parse(liveMetrics);
    expect(JSON.parse(apiWarehouse)).toEqual(metrics);
    expect(metrics.rows.filter((row) => row.metric === "cash_collected").map((row) => row.value)).toEqual([5_000, 25_000]);
    expect(metrics.rows.every((row) => row.group_id === f.memberId)).toBe(true);

    // Same IDs and amounts, with manual provenance, must produce the same credit.
    await f.t.run(async (ctx) => {
      for (const id of f.paymentIds) await ctx.db.patch("paymentRecords", id, {
        origin: "admin_additional", recordedVia: "web", recordedByUserId: f.adminId,
      });
    });
    expect(await f.admin.query(api.reports.scorecard.cash, { range })).toEqual(scorecard);
    expect(await f.admin.query(api.reports.people.getPeopleClosers, liveArgs)).toEqual(people);
    expect(await f.admin.query(api.reports.peopleRoles.getSetters, liveArgs)).toEqual(setters);
    expect(await f.admin.query(api.reports.attribution.getLanes, liveArgs)).toEqual(attribution);
    expect(await readMetrics()).toBe(liveMetrics);
  });
});
