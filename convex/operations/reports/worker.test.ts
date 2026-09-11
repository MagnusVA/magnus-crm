import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { api, internal } from "../../_generated/api";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("scans 32001 monthly events and preserves job idempotency", async () => {
  const t = convexTest({ schema, modules: convexTestModules });
  const fixture = await t.run(async ctx => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Reporting test",
      contactEmail: "test@example.invalid",
      workosOrgId: "org_reporting",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
      slackQualificationDailyTeamQuota: 100,
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_reporting",
      email: "test@example.invalid",
      role: "tenant_admin",
      isActive: true,
    });
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId,
      teamId: "test-team",
      teamName: "Fixture",
      isEnterpriseInstall: false,
      appId: "test-app",
      botUserId: "test-bot",
      botAccessToken: "fixture",
      scopes: [],
      installedByWorkosUserId: "user_reporting",
      installedAt: 0,
      tokenExpiresAt: 0,
      refreshToken: "fixture",
      status: "active",
    });
    return { tenantId, installationId };
  });

  const eventCount = 32_001;
  for (let offset = 0; offset < eventCount; offset += 500) {
    await t.run(async ctx => {
      for (
        let index = offset;
        index < Math.min(offset + 500, eventCount);
        index++
      ) {
        const submittedAt = Date.UTC(2026, 0, 2) + index;
        const slackUserId = "qualifier";
        await ctx.db.insert("slackQualificationEvents", {
          tenantId: fixture.tenantId,
          installationId: fixture.installationId,
          resultKind: "created_opportunity",
          qualifiedBy: {
            slackUserId,
            slackTeamId: "test-team",
            submittedAt,
          },
          slackUserId,
          slackTeamId: "test-team",
          fullNameSnapshot: `Prospect ${index}`,
          platform: "instagram",
          handleSnapshot: `handle${index}`,
          submittedAt,
          createdAt: submittedAt,
        });
      }
    });
  }

  const authed = t.withIdentity({
    subject: "user_reporting",
    org_id: "org_reporting",
  });
  const request = {
    reportKind: "qualifications" as const,
    range: {
      kind: "custom" as const,
      startBusinessDate: "2026-01-01",
      endBusinessDateInclusive: "2026-01-31",
    },
    requestToken: "integration-month",
  };
  const { jobId } = await authed.mutation(
    api.operations.reports.jobs.requestDashboardReport,
    request,
  );
  expect(
    (
      await authed.mutation(
        api.operations.reports.jobs.requestDashboardReport,
        request,
      )
    ).jobId,
  ).toBe(jobId);

  let steps = 0;
  for (; steps < 200; steps++) {
    await t.action(internal.operations.reports.worker.run, { jobId });
    const job = await t.run(ctx => ctx.db.get(jobId));
    if (job?.status === "ready") break;
    expect(job?.status).toBe("queued");
  }
  expect(steps).toBeGreaterThan(1);
  expect(steps).toBeLessThan(200);

  const summary = await authed.query(
    api.operations.reports.jobs.getDashboardReportSummary,
    { jobId },
  );
  expect(summary?.payload).toMatchObject({
    totalQualified: eventCount,
    target: 3100,
  });

  // Replaying an already completed invocation leaves totals unchanged.
  await t.action(internal.operations.reports.worker.run, { jobId });
  expect(
    (
      await authed.query(
        api.operations.reports.jobs.getDashboardReportSummary,
        { jobId },
      )
    )?.payload.totalQualified,
  ).toBe(eventCount);
}, 120_000);

it("pages 8501 materialized groups without gaps", async () => {
  const t = convexTest({ schema, modules: convexTestModules });
  const tenantId = await t.run(async ctx => {
    const id = await ctx.db.insert("tenants", {
      companyName: "Reporting pagination test",
      contactEmail: "pagination@example.invalid",
      workosOrgId: "org_reporting_pagination",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
      slackQualificationDailyTeamQuota: 100,
    });
    await ctx.db.insert("users", {
      tenantId: id,
      workosUserId: "user_reporting_pagination",
      email: "pagination@example.invalid",
      role: "tenant_admin",
      isActive: true,
    });
    return id;
  });
  const authed = t.withIdentity({
    subject: "user_reporting_pagination",
    org_id: "org_reporting_pagination",
  });
  const { jobId } = await authed.mutation(
    api.operations.reports.jobs.requestDashboardReport,
    {
      reportKind: "qualifications",
      range: {
        kind: "custom",
        startBusinessDate: "2026-01-01",
        endBusinessDateInclusive: "2026-01-31",
      },
      requestToken: "integration-groups",
    },
  );

  const groupCount = 8_501;
  const updatedAt = Date.now();
  for (let offset = 0; offset < groupCount; offset += 1_000) {
    await t.run(async ctx => {
      for (
        let index = offset;
        index < Math.min(offset + 1_000, groupCount);
        index++
      ) {
        await ctx.db.insert("operationsReportRows", {
          tenantId,
          jobId,
          section: "qualification_opener",
          rowType: "result",
          rowKey: `qualifier${index}`,
          payload: { qualified: 1, label: `Qualifier ${index}` },
          sortValue: index,
          updatedAt,
        });
      }
    });
  }
  await t.run(async ctx => {
    await ctx.db.patch(jobId, {
      status: "ready",
      phase: "ready",
      completedAt: updatedAt,
      expiresAt: updatedAt + 600_000,
    });
  });

  const seen = new Set<string>();
  let cursor: string | null = null;
  let qualified = 0;
  while (true) {
    const rows: FunctionReturnType<
      typeof api.operations.reports.jobs.listDashboardReportRows
    > = await authed.query(
      api.operations.reports.jobs.listDashboardReportRows,
      {
        jobId,
        section: "qualification_opener",
        paginationOpts: { cursor, numItems: 50 },
      },
    );
    expect(rows.page.length).toBeLessThanOrEqual(50);
    for (const row of rows.page) {
      expect(seen.has(row.rowKey)).toBe(false);
      seen.add(row.rowKey);
      qualified += Number(row.payload.qualified);
    }
    if (rows.isDone) break;
    expect(rows.continueCursor).not.toBe(cursor);
    cursor = rows.continueCursor;
  }
  expect(seen.size).toBe(groupCount);
  expect(qualified).toBe(groupCount);
}, 120_000);

it("keeps live and materialized sales metrics aligned across currencies", async () => {
  const t = convexTest({ schema, modules: convexTestModules });
  const dayKey = "2026-08-14";
  const recordedAt = Date.parse(`${dayKey}T12:00:00.000Z`);
  const fixture = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Sales parity test",
      contactEmail: "sales-parity@example.invalid",
      workosOrgId: "org_sales_parity",
      status: "active",
      inviteExpiresAt: recordedAt + 60_000,
      createdBy: "test",
    });
    const adminId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_sales_parity",
      email: "sales-parity@example.invalid",
      fullName: "Sales Admin",
      role: "tenant_admin",
      isActive: true,
    });
    // This person used to close calls, but is inactive and has since changed
    // roles. Historical activity must still hydrate their identity.
    const historicalCloserId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_historical_closer",
      email: "historical@example.invalid",
      fullName: "Historical Closer",
      role: "tenant_admin",
      isActive: false,
    });
    const callsProgramId = await ctx.db.insert("tenantPrograms", {
      tenantId,
      name: "Calls Program",
      normalizedName: "calls program",
      defaultCurrency: "USD",
      createdAt: recordedAt,
      createdByUserId: adminId,
      updatedAt: recordedAt,
    });
    const paymentOnlyProgramId = await ctx.db.insert("tenantPrograms", {
      tenantId,
      name: "Payment-only Program",
      normalizedName: "payment-only program",
      defaultCurrency: "EUR",
      createdAt: recordedAt,
      createdByUserId: adminId,
      updatedAt: recordedAt,
    });
    await ctx.db.insert("operationsMeetingDailyStats", {
      tenantId,
      dayKey,
      assignedCloserId: historicalCloserId,
      bookingProgramId: callsProgramId,
      meetingStatus: "completed",
      count: 2,
      updatedAt: recordedAt,
    });
    await ctx.db.insert("operationsMeetingDailyStats", {
      tenantId,
      dayKey,
      assignedCloserId: historicalCloserId,
      bookingProgramId: callsProgramId,
      meetingStatus: "canceled",
      count: 1,
      updatedAt: recordedAt,
    });
    for (const payment of [
      { programId: callsProgramId, programName: "Calls Program", currency: "usd", amountMinor: 10_000 },
      { programId: paymentOnlyProgramId, programName: "Payment-only Program", currency: "EUR", amountMinor: 20_000 },
    ]) {
      await ctx.db.insert("paymentRecords", {
        tenantId,
        attributedCloserId: historicalCloserId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        recordedByUserId: adminId,
        commissionable: true,
        programId: payment.programId,
        programName: payment.programName,
        paymentType: "pif",
        status: "recorded",
        statusChangedAt: recordedAt,
        recordedAt,
        contextType: "opportunity",
        origin: "admin_side_deal",
      });
    }
    return { historicalCloserId, paymentOnlyProgramId };
  });
  const authed = t.withIdentity({
    subject: "user_sales_parity",
    org_id: "org_sales_parity",
  });
  const range = {
    kind: "custom" as const,
    startBusinessDate: dayKey,
    endBusinessDateInclusive: dayKey,
  };

  const live = await authed.query(
    api.operations.salesCallsDashboard.getSalesCallsDashboard,
    { range },
  );
  expect(live.capped).toBe(false);
  expect(live.stats).toMatchObject({
    totalCalls: 3,
    showed: 2,
    canceled: 1,
    moneyByCurrency: [
      { currency: "EUR", paymentSalesCount: 1, cashCollectedMinor: 20_000, closeRate: 0.5 },
      { currency: "USD", paymentSalesCount: 1, cashCollectedMinor: 10_000, closeRate: 0.5 },
    ],
  });
  expect(live.closers).toEqual([
    expect.objectContaining({
      closerId: fixture.historicalCloserId,
      label: "Historical Closer",
      booked: 3,
      showed: 2,
      moneyByCurrency: [
        expect.objectContaining({ currency: "EUR", paymentRevenueMinor: 20_000 }),
        expect.objectContaining({ currency: "USD", paymentRevenueMinor: 10_000 }),
      ],
    }),
  ]);
  expect(live.perProgram).toContainEqual(
    expect.objectContaining({
      programId: fixture.paymentOnlyProgramId,
      calls: 0,
      moneyByCurrency: [
        expect.objectContaining({ currency: "EUR", paymentRevenueMinor: 20_000 }),
      ],
    }),
  );

  const { jobId } = await authed.mutation(
    api.operations.reports.jobs.requestDashboardReport,
    { reportKind: "sales-calls", range, requestToken: "sales-currency-parity" },
  );
  for (let steps = 0; steps < 20; steps += 1) {
    await t.action(internal.operations.reports.worker.run, { jobId });
    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    if (job?.status === "ready") break;
    expect(job?.status).toBe("queued");
  }
  expect((await t.run(async (ctx) => await ctx.db.get(jobId)))?.status).toBe("ready");

  const listSection = async (section: string) =>
    (await authed.query(
      api.operations.reports.jobs.listDashboardReportRows,
      { jobId, section, paginationOpts: { cursor: null, numItems: 100 } },
    )).page;
  const summary = await authed.query(
    api.operations.reports.jobs.getDashboardReportSummary,
    { jobId },
  );
  const [summaryMoney, closerRows, closerMoney, programRows, programMoney] =
    await Promise.all([
      listSection("sales_summary_money"),
      listSection("sales_closer"),
      listSection("sales_closer_money"),
      listSection("sales_program"),
      listSection("sales_program_money"),
    ]);

  expect(summary).not.toBeNull();
  if (!summary) throw new Error("Expected the current report summary.");
  expect(summary.payload).toMatchObject({ totalCalls: 3, showed: 2, canceled: 1 });
  expect(summaryMoney.map((row) => row.payload)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ currency: "EUR", paymentSalesCount: 1, cashCollectedMinor: 20_000, closeRate: 0.5 }),
      expect.objectContaining({ currency: "USD", paymentSalesCount: 1, cashCollectedMinor: 10_000, closeRate: 0.5 }),
    ]),
  );
  expect(closerRows).toContainEqual(expect.objectContaining({
    rowKey: fixture.historicalCloserId,
    payload: expect.objectContaining({ label: "Historical Closer", booked: 3, identityName: "Historical Closer" }),
  }));
  expect(closerMoney).toHaveLength(2);
  expect(closerMoney.every((row) => row.groupKey === fixture.historicalCloserId)).toBe(true);
  expect(programRows).toContainEqual(expect.objectContaining({
    rowKey: fixture.paymentOnlyProgramId,
    payload: expect.objectContaining({ label: "Payment-only Program", calls: 0, showUpRate: null }),
  }));
  expect(programMoney).toContainEqual(expect.objectContaining({
    groupKey: fixture.paymentOnlyProgramId,
    payload: expect.objectContaining({ currency: "EUR", paymentRevenueMinor: 20_000 }),
  }));
});
