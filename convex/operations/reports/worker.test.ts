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
