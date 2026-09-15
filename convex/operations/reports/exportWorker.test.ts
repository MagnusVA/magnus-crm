// @vitest-environment node
import { convexTest } from "convex-test";
import type {
  FunctionArgs,
  GenericDatabaseWriter,
  GenericDataModel,
} from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx-js-style";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { api, internal } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";
import * as jobFunctions from "./jobs";
import { REPORT_LEASE_MS } from "./contracts";

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  // convex-test omits Blob.type in _storage. Supply only that missing platform
  // metadata; run the actual hash/size/ownership validation and publication.
  const attach = async (
    ctx: MutationCtx,
    args: FunctionArgs<typeof internal.operations.reports.jobs.attachArtifact>,
  ) => {
    const artifact = await ctx.db.get(args.artifactId);
    const db: GenericDatabaseWriter<GenericDataModel> = ctx.db;
    await db.patch(args.storageId, {
      contentType: artifact!.ownershipContentType,
    });
    const original = jobFunctions.attachArtifact;
    if (!("_handler" in original) || typeof original._handler !== "function")
      throw new Error("Missing Convex test handler");
    return original._handler(ctx, args);
  };
  const t = convexTest({
    schema,
    modules: {
      ...convexTestModules,
      "./operations/reports/jobs.ts": async () => ({
        ...jobFunctions,
        attachArtifact: { ...jobFunctions.attachArtifact, _handler: attach },
      }),
    },
  });
  const ids = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Export test",
      contactEmail: "export@example.invalid",
      workosOrgId: "org_export_test",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    const userId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_export_test",
      email: "export@example.invalid",
      role: "tenant_admin",
      isActive: true,
    });
    const workerId = await ctx.db.insert("leadGenWorkers", {
      tenantId,
      userId,
      workosUserId: "user_export_test",
      email: "export@example.invalid",
      displayName: "=Specialist",
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    });
    for (let day = 1; day <= 31; day++)
      await ctx.db.insert("leadGenDailyStats", {
        tenantId,
        workerId,
        userId,
        statKey: `daily-${day}`,
        dayKey: `2026-08-${String(day).padStart(2, "0")}`,
        source: "instagram",
        submissions: day,
        uniqueProspectsSubmitted: day,
        duplicateProspectSubmissions: 0,
        scheduledHours: 8,
        updatedAt: 0,
      });
    const prospectId = await ctx.db.insert("leadGenProspects", {
      tenantId,
      firstSource: "instagram",
      latestSource: "instagram",
      dedupeKey: "fixture",
      normalizedHandle: "prospect",
      rawHandle: "@prospect",
      profileUrl: "https://example.invalid/prospect",
      firstCapturedByWorkerId: workerId,
      firstCapturedAt: 0,
      lastSubmittedByWorkerId: workerId,
      lastSubmittedAt: 0,
      latestOriginKind: "post",
      contactAttemptCount: 1,
      distinctWorkerCount: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    for (let i = 0; i < 101; i++)
      await ctx.db.insert("leadGenSubmissions", {
        tenantId,
        workerId,
        userId,
        prospectId,
        source: "instagram",
        originKind: "post",
        originRankable: true,
        submittedAt: Date.UTC(2026, 7, 15) + i,
        createdAt: 0,
      });
    return { tenantId, userId, workerId };
  });
  return {
    t,
    ...ids,
    caller: t.withIdentity({
      subject: "user_export_test",
      org_id: "org_export_test",
    }),
  };
}

const request = {
  reportKind: "lead-gen" as const,
  range: {
    kind: "custom" as const,
    startBusinessDate: "2026-08-01",
    endBusinessDateInclusive: "2026-08-31",
  },
};

it.each(["raw_csv", "summary_csv", "xlsx", "pdf"] as const)(
  "publishes one complete %s with no staged export rows",
  async (format) => {
    const { t, caller, tenantId } = await fixture();
    if (format === "pdf") {
      // Exceed the former 300-row split boundary using actual source pages.
      for (let offset = 0; offset < 1100; offset += 100) {
        await t.run(async (ctx) => {
          for (let i = offset; i < offset + 100; i++) {
            await ctx.db.insert("leadGenOriginStats", {
              tenantId,
              originKey: `origin-${i}`,
              dayKey: "2026-08-15",
              source: "instagram",
              originKind: "post",
              originValue: `https://example.invalid/post-${i}`,
              submissions: 1,
              uniqueProspectsSubmitted: 1,
              updatedAt: 0,
            });
          }
        });
      }
    }
    const { jobId } = await caller.mutation(
      api.operations.reports.jobs.requestExport,
      { ...request, format, requestToken: format },
    );
    await t.action(internal.operations.reports.exportWorker.run, { jobId });
    const state = await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const artifacts = await ctx.db
        .query("operationsReportArtifacts")
        .withIndex("by_jobId_and_partNumber", (q) => q.eq("jobId", jobId))
        .take(2);
      const rows = await ctx.db
        .query("operationsReportRows")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .first();
      const admission = await ctx.db
        .query("operationsReportAdmission")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .unique();
      const file = artifacts[0]?.storageId
        ? await ctx.storage.get(artifacts[0].storageId)
        : null;
      return {
        job,
        artifacts,
        rows,
        admission,
        file: (await file?.arrayBuffer()) ?? null,
      };
    });
    expect(state.job).toMatchObject({ status: "ready", artifactCount: 1 });
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0]).toMatchObject({ reconciliationComplete: true });
    expect(state.artifacts[0].filename).not.toContain("part");
    expect(state.rows).toBeNull();
    if (format === "pdf")
      expect(state.artifacts[0].rowCount).toBeGreaterThanOrEqual(1100);
    expect(state.admission?.slots).toEqual([]);
    if (format === "raw_csv") {
      const text = new TextDecoder().decode(state.file!);
      expect(text.trim().split("\r\n")).toHaveLength(102);
      expect(text).toContain("'=Specialist");
      expect(text.match(/RangeEndInclusive/g)).toHaveLength(1);
      expect(state.artifacts[0].rowCount).toBe(101);
    }
    if (format === "summary_csv") {
      const text = new TextDecoder().decode(state.file!);
      expect(text.trim().split("\r\n")).toHaveLength(32);
      expect(text).toContain("2026-08-31");
    }
    if (format === "xlsx") {
      const workbook = XLSX.read(state.file!);
      const text = Object.values(workbook.Sheets)
        .map((sheet) => XLSX.utils.sheet_to_csv(sheet))
        .join("\n");
      expect(text).toContain("Specialist Performance");
      expect(text).toContain("496");
      expect(text).not.toContain("Part 1");
    }
  },
);

it("deduplicates admission without writing it for progress and releases it on cancellation", async () => {
  const { t, caller, tenantId } = await fixture();
  const first = await caller.mutation(
    api.operations.reports.jobs.requestExport,
    { ...request, format: "pdf", requestToken: "one" },
  );
  expect(
    await caller.mutation(api.operations.reports.jobs.requestExport, {
      ...request,
      format: "pdf",
      requestToken: "two",
    }),
  ).toEqual(first);
  const admission = () =>
    t.run((ctx) =>
      ctx.db
        .query("operationsReportAdmission")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .unique(),
    );
  const before = await admission();
  const claim = await t.mutation(internal.operations.reports.jobs.claimJob, {
    jobId: first.jobId,
    workerId: "test",
  });
  if (claim.kind !== "claimed") throw new Error("claim failed");
  const fence = {
    jobId: first.jobId,
    workerId: "test",
    leaseGeneration: claim.leaseGeneration,
  };
  await t.mutation(internal.operations.reports.jobs.updateExportProgress, {
    ...fence,
    rowsProcessed: 5,
    pagesProcessed: 1,
  });
  expect(await admission()).toEqual(before);
  await caller.mutation(api.operations.reports.jobs.cancelReport, {
    jobId: first.jobId,
  });
  expect((await admission())?.slots).toEqual([]);
  expect(
    await t.mutation(internal.operations.reports.jobs.updateExportProgress, {
      ...fence,
      rowsProcessed: 9,
      pagesProcessed: 2,
    }),
  ).toEqual({ updated: false });
});

it.each(["pending", "inProgress"] as const)(
  "does not recover a %s invocation just because its lease is stale",
  async (stateKind) => {
    vi.useFakeTimers();
    try {
      const { t, caller } = await fixture();
      const { jobId } = await caller.mutation(
        api.operations.reports.jobs.requestExport,
        { ...request, format: "pdf", requestToken: "live" },
      );
      await t.mutation(internal.operations.reports.jobs.claimJob, {
        jobId,
        workerId: "test",
      });
      const scheduledBefore = await t.run(
        async (ctx) => (await ctx.db.get(jobId))!.scheduledFunctionId,
      );
      await t.run(async (ctx) => {
        const db: GenericDatabaseWriter<GenericDataModel> = ctx.db;
        await db.patch(scheduledBefore!, { state: { kind: stateKind } });
      });
      vi.setSystemTime(Date.now() + REPORT_LEASE_MS + 1);
      expect(
        await t.mutation(
          internal.operations.reports.recovery.recoverStaleReports,
          {},
        ),
      ).toMatchObject({ recovered: 0 });
      const state = await t.run((ctx) => ctx.db.get(jobId));
      expect(state?.scheduledFunctionId).toBe(scheduledBefore);
      expect(state?.retryCount).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

it("restarts a dead invocation and fences out its previous worker", async () => {
  vi.useFakeTimers();
  try {
    const { t, caller } = await fixture();
    const { jobId } = await caller.mutation(
      api.operations.reports.jobs.requestExport,
      { ...request, format: "pdf", requestToken: "dead" },
    );
    const claim = await t.mutation(internal.operations.reports.jobs.claimJob, {
      jobId,
      workerId: "old",
    });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    await t.run(async (ctx) => {
      const job = (await ctx.db.get(jobId))!;
      await ctx.scheduler.cancel(job.scheduledFunctionId!);
    });
    vi.setSystemTime(Date.now() + REPORT_LEASE_MS + 1);
    expect(
      await t.mutation(
        internal.operations.reports.recovery.recoverStaleReports,
        {},
      ),
    ).toMatchObject({ recovered: 1 });
    expect(
      await t.mutation(internal.operations.reports.jobs.updateExportProgress, {
        jobId,
        workerId: "old",
        leaseGeneration: claim.leaseGeneration,
        rowsProcessed: 9,
        pagesProcessed: 2,
      }),
    ).toEqual({ updated: false });
    await t.action(internal.operations.reports.exportWorker.run, { jobId });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      status: "ready",
      artifactCount: 1,
      retryCount: 1,
    });
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("bootstraps admission from a legacy active job and releases it when that job ends", async () => {
  const { t, caller, tenantId } = await fixture();
  const first = await caller.mutation(
    api.operations.reports.jobs.requestExport,
    { ...request, format: "pdf", requestToken: "legacy" },
  );
  await t.run(async (ctx) => {
    await ctx.db.patch(first.jobId, { executionVersion: undefined });
    const admission = await ctx.db
      .query("operationsReportAdmission")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();
    await ctx.db.delete(admission!._id);
  });
  expect(
    await caller.mutation(api.operations.reports.jobs.requestExport, {
      ...request,
      format: "pdf",
      requestToken: "equivalent",
    }),
  ).toEqual(first);
  await expect(
    caller.mutation(api.operations.reports.jobs.requestExport, {
      ...request,
      format: "xlsx",
      requestToken: "different",
    }),
  ).rejects.toThrow("already have an active");
  await caller.mutation(api.operations.reports.jobs.cancelReport, {
    jobId: first.jobId,
  });
  const next = await caller.mutation(
    api.operations.reports.jobs.requestExport,
    { ...request, format: "xlsx", requestToken: "after-cancel" },
  );
  expect(next.jobId).not.toBe(first.jobId);
  expect(await t.run((ctx) => ctx.db.get(next.jobId))).toMatchObject({
    executionVersion: 2,
  });
});
