import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { normalizeReportRange } from "./contracts";

const dashboardRequest = {
  reportKind: "lead-gen" as const,
  range: { kind: "preset" as const, preset: "today" as const },
  requestToken: "security-dashboard-request",
};

const exportRequest = {
  reportKind: "lead-gen" as const,
  format: "summary_csv" as const,
  range: { kind: "preset" as const, preset: "today" as const },
  requestToken: "security-export-request",
};

describe("operations report public API security", () => {
  it("rejects unauthenticated and closer report requests", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.t.mutation(
        api.operations.reports.jobs.requestDashboardReport,
        dashboardRequest,
      ),
    ).rejects.toThrow("Not authenticated");
    await expect(
      fixture.t.mutation(api.operations.reports.jobs.requestExport, exportRequest),
    ).rejects.toThrow("Not authenticated");

    const closer = fixture.t.withIdentity({
      subject: "closer_a",
      org_id: "org_a",
    });
    await expect(
      closer.mutation(
        api.operations.reports.jobs.requestDashboardReport,
        dashboardRequest,
      ),
    ).rejects.toThrow("Insufficient permissions");
    await expect(
      closer.mutation(api.operations.reports.jobs.requestExport, exportRequest),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("hides jobs, rows, artifacts, downloads, and cancellation from other users", async () => {
    const fixture = await createFixture();
    const sameTenantOtherOwner = fixture.t.withIdentity({
      subject: "admin_a_other",
      org_id: "org_a",
    });
    const otherTenant = fixture.t.withIdentity({
      subject: "admin_b",
      org_id: "org_b",
    });

    for (const caller of [sameTenantOtherOwner, otherTenant]) {
      await expect(
        caller.query(api.operations.reports.jobs.getReportJob, {
          jobId: fixture.exportJobId,
        }),
      ).rejects.toThrow("Report job not found");
      await expect(
        caller.query(api.operations.reports.jobs.getDashboardReportSummary, {
          jobId: fixture.dashboardJobId,
        }),
      ).rejects.toThrow("Report job not found");
      await expect(
        caller.query(api.operations.reports.jobs.listDashboardReportRows, {
          jobId: fixture.dashboardJobId,
          section: "lead_gen_worker",
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      ).rejects.toThrow("Report job not found");
      await expect(
        caller.query(api.operations.reports.jobs.listReportArtifacts, {
          jobId: fixture.exportJobId,
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      ).rejects.toThrow("Report job not found");
      await expect(
        caller.mutation(api.operations.reports.jobs.requestReportDownload, {
          jobId: fixture.exportJobId,
          artifactId: fixture.artifactId,
        }),
      ).rejects.toThrow("Report job not found");
      await expect(
        caller.mutation(api.operations.reports.jobs.cancelReport, {
          jobId: fixture.queuedJobId,
        }),
      ).rejects.toThrow("Report job not found");
    }

    expect(
      await fixture.t.run(async (ctx) =>
        (await ctx.db.get(fixture.queuedJobId))?.status,
      ),
    ).toBe("queued");
  });

  it("checks expiry on each download request without changing ready status", async () => {
    const fixture = await createFixture({ exportExpired: true });
    const owner = fixture.t.withIdentity({
      subject: "admin_a",
      org_id: "org_a",
    });

    await expect(
      owner.mutation(api.operations.reports.jobs.requestReportDownload, {
        jobId: fixture.exportJobId,
        artifactId: fixture.artifactId,
      }),
    ).rejects.toThrow("This report download is no longer available");

    expect(
      await fixture.t.run(async (ctx) =>
        (await ctx.db.get(fixture.exportJobId))?.status,
      ),
    ).toBe("ready");
  });

  it("cancels a queued job before claiming it when its owner is revoked", async () => {
    const fixture = await createFixture();
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.ownerId, { isActive: false });
    });

    await expect(
      fixture.t.mutation(internal.operations.reports.jobs.claimJob, {
        jobId: fixture.queuedJobId,
        workerId: "security-worker",
      }),
    ).resolves.toEqual({ kind: "skip", reason: "Owner access was revoked." });

    expect(
      await fixture.t.run(async (ctx) => {
        const job = await ctx.db.get(fixture.queuedJobId);
        return {
          status: job?.status,
          phase: job?.phase,
          failure: job?.failure,
          leaseOwner: job?.leaseOwner,
        };
      }),
    ).toEqual({
      status: "canceled",
      phase: "cleanup",
      failure: {
        category: "authorization",
        message: "Report owner no longer has access.",
        retryable: false,
      },
      leaseOwner: undefined,
    });
  });

  it("rejects reuse of an idempotency token for a different request", async () => {
    const fixture = await createFixture();
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.queuedJobId, {
        status: "canceled",
        phase: "cleanup",
      });
    });
    const owner = fixture.t.withIdentity({
      subject: "admin_a",
      org_id: "org_a",
    });
    const request = {
      ...dashboardRequest,
      requestToken: "same-token-different-request",
    };

    await owner.mutation(
      api.operations.reports.jobs.requestDashboardReport,
      request,
    );
    await expect(
      owner.mutation(api.operations.reports.jobs.requestDashboardReport, {
        ...request,
        reportKind: "qualifications",
      }),
    ).rejects.toThrow("Request token was already used for a different report");
  });
});

async function createFixture(options: { exportExpired?: boolean } = {}) {
  const t = convexTest({ schema, modules: convexTestModules });
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const tenantAId = await ctx.db.insert("tenants", {
      companyName: "Tenant A",
      contactEmail: "a@example.invalid",
      workosOrgId: "org_a",
      status: "active",
      inviteExpiresAt: now + 60_000,
      createdBy: "test",
    });
    const tenantBId = await ctx.db.insert("tenants", {
      companyName: "Tenant B",
      contactEmail: "b@example.invalid",
      workosOrgId: "org_b",
      status: "active",
      inviteExpiresAt: now + 60_000,
      createdBy: "test",
    });
    const ownerId = await insertUser(ctx, tenantAId, {
      workosUserId: "admin_a",
      email: "admin-a@example.invalid",
      role: "tenant_admin",
    });
    await insertUser(ctx, tenantAId, {
      workosUserId: "admin_a_other",
      email: "admin-a-other@example.invalid",
      role: "tenant_admin",
    });
    await insertUser(ctx, tenantAId, {
      workosUserId: "closer_a",
      email: "closer-a@example.invalid",
      role: "closer",
    });
    await insertUser(ctx, tenantBId, {
      workosUserId: "admin_b",
      email: "admin-b@example.invalid",
      role: "tenant_admin",
    });

    const dashboardJobId = await insertJob(ctx, {
      tenantId: tenantAId,
      ownerId,
      requestToken: "dashboard-fixture",
      purpose: "dashboard",
      status: "ready",
      phase: "ready",
      completedAt: now,
      expiresAt: now + 60_000,
    });
    await ctx.db.insert("operationsReportRows", {
      tenantId: tenantAId,
      jobId: dashboardJobId,
      rowType: "result",
      section: "lead_gen_summary",
      rowKey: "main",
      payload: { submissions: 1 },
      updatedAt: now,
    });
    await ctx.db.insert("operationsReportRows", {
      tenantId: tenantAId,
      jobId: dashboardJobId,
      rowType: "result",
      section: "lead_gen_worker",
      rowKey: "worker-1",
      payload: { submissions: 1 },
      sortValue: 1,
      updatedAt: now,
    });

    const exportJobId = await insertJob(ctx, {
      tenantId: tenantAId,
      ownerId,
      requestToken: "export-fixture",
      purpose: "export",
      format: "summary_csv",
      status: "ready",
      phase: "ready",
      completedAt: now,
      expiresAt: options.exportExpired ? now - 1 : now + 60_000,
    });
    const artifactId = await ctx.db.insert("operationsReportArtifacts", {
      tenantId: tenantAId,
      jobId: exportJobId,
      partNumber: 0,
      filename: "lead-gen.csv",
      mimeType: "text/csv;charset=utf-8",
      ownershipContentType:
        "text/csv;charset=utf-8; report-token=securitytoken0000000",
      state: "attached",
      expectedSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      expectedByteSize: 1,
      byteSize: 1,
      rowCount: 1,
      ownershipToken: "securitytoken0000000",
      reservedAt: now,
      reservationExpiresAt: now + 60_000,
      attachedAt: now,
      expiresAt: options.exportExpired ? now - 1 : now + 60_000,
      reconciliationComplete: true,
      deleteAttempts: 0,
      updatedAt: now,
    });
    const queuedJobId = await insertJob(ctx, {
      tenantId: tenantAId,
      ownerId,
      requestToken: "queued-fixture",
      purpose: "dashboard",
      status: "queued",
      phase: "queued",
    });

    return {
      ownerId,
      dashboardJobId,
      exportJobId,
      artifactId,
      queuedJobId,
    };
  });
  return { t, ...ids };
}

type TestRunContext = Parameters<
  Parameters<ReturnType<typeof convexTest>["run"]>[0]
>[0];

async function insertUser(
  ctx: TestRunContext,
  tenantId: Id<"tenants">,
  user: {
    workosUserId: string;
    email: string;
    role: "tenant_admin" | "closer";
  },
) {
  return await ctx.db.insert("users", {
    tenantId,
    ...user,
    isActive: true,
  });
}

async function insertJob(
  ctx: TestRunContext,
  args: {
    tenantId: Id<"tenants">;
    ownerId: Id<"users">;
    requestToken: string;
    purpose: "dashboard" | "export";
    format?: "summary_csv";
    status: "queued" | "ready";
    phase: "queued" | "ready";
    completedAt?: number;
    expiresAt?: number;
  },
) {
  const now = Date.now();
  return await ctx.db.insert("operationsReportJobs", {
    tenantId: args.tenantId,
    requestedByUserId: args.ownerId,
    purpose: args.purpose,
    reportKind: "lead-gen",
    format: args.format,
    range: normalizeReportRange({
      reportKind: "lead-gen",
      input: { kind: "preset", preset: "today" },
      now,
    }),
    sourceFilter: "all",
    requestToken: args.requestToken,
    requestKey: `${args.requestToken}-key`,
    definitionVersion: "security-test-v1",
    status: args.status,
    phase: args.phase,
    rowsProcessed: 0,
    pagesProcessed: 0,
    artifactCount: args.purpose === "export" ? 1 : 0,
    checkpointSequence: 0,
    leaseGeneration: 0,
    retryCount: 0,
    queuedAt: now,
    createdAt: now,
    completedAt: args.completedAt,
    expiresAt: args.expiresAt,
    cleanupPending: false,
  });
}

const modules = convexTestModules;

it.each(["heartbeat", "completion"] as const)(
  "cancels %s when the owner loses their admin role after claim",
  async (transition) => {
    vi.useFakeTimers();
    try {
      const t = createRevocationHarness();
      const { jobId, userId } = await insertRevocationJobFixture(t);
      const claim = await t.mutation(internal.operations.reports.jobs.claimJob, {
        jobId, workerId: "worker-one",
      });
      if (claim.kind !== "claimed") throw new Error("Expected claimed job.");
      await t.run(async (ctx) => {
        await ctx.db.patch(userId, { role: "closer" });
      });
      const fence = { jobId, workerId: "worker-one", leaseGeneration: claim.leaseGeneration };
      if (transition === "heartbeat") {
        expect(await t.mutation(internal.operations.reports.jobs.heartbeatLease, fence))
          .toEqual({ renewed: false });
      } else {
        const result = await t.mutation(internal.operations.reports.jobs.completeJob, {
          ...fence, expectedSequence: claim.checkpointSequence,
          commitKey: "complete:0", expectedArtifactCount: 0,
        });
        expect(result.kind).toBe("stale");
      }
      const job = await t.run(async (ctx) => await ctx.db.get(jobId));
      expect(job).toMatchObject({
        status: "canceled", phase: "cleanup", cleanupPending: true,
        failure: { category: "authorization", retryable: false },
        leaseGeneration: claim.leaseGeneration + 1,
      });
      expect(job?.leaseOwner).toBeUndefined();
      expect(job?.leaseExpiresAt).toBeUndefined();
      expect(job?.cleanupNextAttemptAt).toBeTypeOf("number");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

function createRevocationHarness() {
  return convexTest({ schema, modules });
}

type RevocationHarness = ReturnType<typeof createRevocationHarness>;

async function insertRevocationJobFixture(
  t: RevocationHarness,
  overrides: Partial<{
    status: "queued" | "ready";
    phase: "queued" | "ready";
    completedAt: number;
    expiresAt: number;
  }> = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Fixture",
      contactEmail: "fixture@example.com",
      workosOrgId: "org_fixture",
      status: "active",
      inviteExpiresAt: now + 60_000,
      createdBy: "test",
    });
    const userId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_fixture",
      email: "admin@example.com",
      role: "tenant_admin",
      isActive: true,
    });
    const status = overrides.status ?? "queued";
    const jobId = await ctx.db.insert("operationsReportJobs", {
      tenantId,
      requestedByUserId: userId,
      purpose: "dashboard",
      reportKind: "lead-gen",
      range: normalizeReportRange({
        reportKind: "lead-gen",
        input: { kind: "preset", preset: "today" },
        now,
      }),
      sourceFilter: "all",
      requestToken: "fixture-token",
      requestKey: "fixture-key",
      definitionVersion: "fixture-v1",
      status,
      phase: overrides.phase ?? "queued",
      rowsProcessed: 0,
      pagesProcessed: 0,
      artifactCount: 0,
      checkpointSequence: 0,
      leaseGeneration: 0,
      retryCount: 0,
      queuedAt: now,
      createdAt: now,
      completedAt: overrides.completedAt,
      expiresAt: overrides.expiresAt,
      cleanupPending: false,
    });
    return { tenantId, userId, jobId };
  });
}
