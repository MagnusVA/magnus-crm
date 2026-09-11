import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { normalizeReportRange, REPORT_DEFINITION_VERSION } from "./contracts";

const modules = convexTestModules;

describe("operations report job lifecycle", () => {
  it("commits one source page exactly once and deduplicates unique sums", async () => {
    const t = createHarness();
    const { jobId } = await insertJobFixture(t);
    const claim = await t.mutation(internal.operations.reports.jobs.claimJob, {
      jobId,
      workerId: "worker-one",
    });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("Expected a claimed job.");

    const first = await t.mutation(
      internal.operations.reports.jobs.commitCheckpoint,
      {
        jobId,
        workerId: "worker-one",
        leaseGeneration: claim.leaseGeneration,
        expectedSequence: claim.checkpointSequence,
        commitKey: "daily:page-1",
        sourceKey: "daily",
        cursor: "cursor-1",
        completed: false,
        rowsProcessed: 1,
        scheduleNext: false,
        contributions: [
          {
            section: "lead_gen_summary",
            rowKey: "main",
            field: "submissions",
            operation: "sum",
            value: 2,
          },
          {
            section: "lead_gen_summary",
            rowKey: "main",
            field: "scheduledHours",
            operation: "uniqueSum",
            value: 5,
            dedupeKey: "worker:day",
          },
          {
            section: "lead_gen_origin",
            rowKey: `instagram:https://example.com/${"a".repeat(1_000)}`,
            field: "submissions",
            operation: "sum",
            value: 1,
          },
        ],
      },
    );
    expect(first).toEqual({ kind: "committed", sequence: 1 });

    const replay = await t.mutation(
      internal.operations.reports.jobs.commitCheckpoint,
      {
        jobId,
        workerId: "worker-one",
        leaseGeneration: claim.leaseGeneration,
        expectedSequence: 0,
        commitKey: "daily:page-1",
        sourceKey: "daily",
        cursor: "cursor-1",
        completed: false,
        rowsProcessed: 1,
        scheduleNext: false,
        contributions: [],
      },
    );
    expect(replay).toEqual({ kind: "already_committed", sequence: 1 });

    await t.mutation(internal.operations.reports.jobs.commitCheckpoint, {
      jobId,
      workerId: "worker-one",
      leaseGeneration: claim.leaseGeneration,
      expectedSequence: 1,
      commitKey: "daily:page-2",
      sourceKey: "daily",
      completed: true,
      rowsProcessed: 1,
      scheduleNext: false,
      contributions: [
        {
          section: "lead_gen_summary",
          rowKey: "main",
          field: "scheduledHours",
          operation: "uniqueSum",
          value: 5,
          dedupeKey: "worker:day",
        },
      ],
    });

    const snapshot = await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const row = await ctx.db
        .query("operationsReportRows")
        .withIndex("by_jobId_and_section_and_rowKey", (q) =>
          q
            .eq("jobId", jobId)
            .eq("section", "lead_gen_summary")
            .eq("rowKey", "main"),
        )
        .unique();
      return { job, row };
    });
    expect(snapshot.job).toMatchObject({
      checkpointSequence: 2,
      rowsProcessed: 2,
      pagesProcessed: 2,
    });
    expect(snapshot.row?.payload).toEqual({ submissions: 2, scheduledHours: 5 });
  });

  it("rejects a checkpoint from a fenced lease", async () => {
    const t = createHarness();
    const { jobId } = await insertJobFixture(t);
    const claim = await t.mutation(internal.operations.reports.jobs.claimJob, {
      jobId,
      workerId: "worker-one",
    });
    if (claim.kind !== "claimed") throw new Error("Expected a claimed job.");
    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, { leaseGeneration: claim.leaseGeneration + 1 });
    });
    const result = await t.mutation(
      internal.operations.reports.jobs.commitCheckpoint,
      {
        jobId,
        workerId: "worker-one",
        leaseGeneration: claim.leaseGeneration,
        expectedSequence: 0,
        commitKey: "stale-page",
        sourceKey: "daily",
        completed: false,
        rowsProcessed: 0,
        contributions: [],
        scheduleNext: false,
      },
    );
    expect(result.kind).toBe("stale");
  });

  it("defers a retry while any artifact part is still reserved", async () => {
    const t = createHarness();
    const { jobId, tenantId } = await insertJobFixture(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let partNumber = 0; partNumber < 51; partNumber += 1) {
        await ctx.db.insert("operationsReportArtifacts", {
          tenantId,
          jobId,
          partNumber,
          filename: `part-${partNumber}.csv`,
          mimeType: "text/csv;charset=utf-8",
          ownershipContentType: `text/csv;charset=utf-8; report-token=token${String(partNumber).padStart(16, "0")}`,
          state: partNumber === 50 ? "reserved" : "attached",
          expectedSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          expectedByteSize: 1,
          rowCount: 1,
          ownershipToken: `token${String(partNumber).padStart(16, "0")}`,
          reservedAt: now,
          reservationExpiresAt: now + 60_000,
          reconciliationComplete: partNumber !== 50,
          deleteAttempts: 0,
          updatedAt: now,
        });
      }
    });
    const claim = await t.mutation(internal.operations.reports.jobs.claimJob, {
      jobId,
      workerId: "worker-one",
    });
    expect(claim).toEqual({
      kind: "skip",
      reason: "An interrupted artifact upload is being reconciled.",
    });
  });

  it("expires ready jobs and removes children in bounded cleanup steps", async () => {
    const t = createHarness();
    const { jobId, tenantId } = await insertJobFixture(t, {
      status: "ready",
      phase: "ready",
      expiresAt: Date.now() - 1,
      completedAt: Date.now() - 2,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("operationsReportRows", {
        tenantId,
        jobId,
        rowType: "result",
        section: "lead_gen_summary",
        rowKey: "main",
        payload: { submissions: 1 },
        updatedAt: Date.now(),
      });
    });

    await t.mutation(
      internal.operations.reports.cleanup.expireReadyJobs,
      {},
    );
    await t.mutation(
      internal.operations.reports.cleanup.cleanupTerminalJobs,
      {},
    );
    await t.mutation(
      internal.operations.reports.cleanup.cleanupTerminalJobs,
      {},
    );

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      row: await ctx.db
        .query("operationsReportRows")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .first(),
    }));
    expect(state.row).toBeNull();
    expect(state.job).toMatchObject({
      status: "expired",
      phase: "cleanup",
      cleanupPending: false,
    });
  });

  it("defers a blocked cleanup job so another terminal job can progress", async () => {
    const t = createHarness();
    const blocked = await insertJobFixture(t);
    const eligible = await insertJobFixture(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(blocked.jobId, {
        status: "failed",
        phase: "cleanup",
        expiresAt: now - 2,
        purgeAt: now + 60_000,
        cleanupPending: true,
        cleanupNextAttemptAt: now - 2,
      });
      await ctx.db.insert("operationsReportArtifacts", {
        tenantId: blocked.tenantId,
        jobId: blocked.jobId,
        partNumber: 1,
        filename: "blocked.csv",
        mimeType: "text/csv;charset=utf-8",
        ownershipContentType: "text/csv;charset=utf-8; report-token=blockedtoken00000000",
        state: "reserved",
        expectedSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        expectedByteSize: 1,
        rowCount: 1,
        ownershipToken: "blockedtoken00000000",
        reservedAt: now,
        reservationExpiresAt: now + 60_000,
        reconciliationComplete: false,
        deleteAttempts: 0,
        updatedAt: now,
      });
      await ctx.db.patch(eligible.jobId, {
        status: "failed",
        phase: "cleanup",
        expiresAt: now - 1,
        purgeAt: now + 60_000,
        cleanupPending: true,
        cleanupNextAttemptAt: now - 1,
      });
      await ctx.db.insert("operationsReportRows", {
        tenantId: eligible.tenantId,
        jobId: eligible.jobId,
        rowType: "result",
        section: "lead_gen_summary",
        rowKey: "main",
        payload: { submissions: 1 },
        updatedAt: now,
      });
    });

    await t.mutation(internal.operations.reports.cleanup.cleanupTerminalJobs, {});
    await t.mutation(internal.operations.reports.cleanup.cleanupTerminalJobs, {});
    const remaining = await t.run(async (ctx) =>
      await ctx.db
        .query("operationsReportRows")
        .withIndex("by_jobId", (q) => q.eq("jobId", eligible.jobId))
        .first(),
    );
    expect(remaining).toBeNull();
  });
});

function createHarness() {
  return convexTest({ schema, modules });
}

type TestHarness = ReturnType<typeof createHarness>;

async function insertJobFixture(
  t: TestHarness,
  overrides: Partial<{
    status: "queued" | "ready";
    phase: "queued" | "ready";
    completedAt: number;
    expiresAt: number;
    definitionVersion: string;
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
      definitionVersion: overrides.definitionVersion ?? REPORT_DEFINITION_VERSION,
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

it("fails an outdated queued job before a worker can resume its checkpoints", async () => {
  const t = createHarness();
  const { jobId } = await insertJobFixture(t, {
    definitionVersion: "operations-reports-v1",
  });

  const claim = await t.mutation(internal.operations.reports.jobs.claimJob, {
    jobId,
    workerId: "worker-one",
  });

  expect(claim).toEqual({
    kind: "skip",
    reason: "Report definition is outdated.",
  });
  const job = await t.run(async (ctx) => await ctx.db.get(jobId));
  expect(job).toMatchObject({
    status: "failed",
    failure: {
      category: "definition_version",
      message: "This report was created with an older definition. Regenerate the report.",
      retryable: false,
    },
  });
});

it("projects an outdated ready dashboard as failed and suppresses its summary", async () => {
  const t = createHarness();
  const { jobId } = await insertJobFixture(t, {
    status: "ready",
    phase: "ready",
    completedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    definitionVersion: "operations-reports-v1",
  });
  const authed = t.withIdentity({
    subject: "user_fixture",
    org_id: "org_fixture",
  });

  expect(await authed.query(api.operations.reports.jobs.getReportJob, { jobId }))
    .toMatchObject({
      status: "failed",
      failure: {
        category: "definition_version",
        retryable: false,
      },
    });
  expect(await authed.query(
    api.operations.reports.jobs.getDashboardReportSummary,
    { jobId },
  )).toBeNull();
});


it("drains multiple expiration, cleanup, and purge batches through scheduled continuations", async () => {
  vi.useFakeTimers();
  try {
    const t = createHarness();
    const now = Date.now();
    const jobIds: Id<"operationsReportJobs">[] = [];
    for (let index = 0; index < 51; index += 1) {
      const { jobId, tenantId } = await insertJobFixture(t, {
        status: "ready", phase: "ready", completedAt: now - 1000, expiresAt: now - 1,
      });
      jobIds.push(jobId);
      await t.run(async (ctx) => {
        await ctx.db.patch(jobId, { purgeAt: now - 1 });
        await ctx.db.insert("operationsReportRows", {
          tenantId, jobId, rowType: "result", section: "lead_gen_summary",
          rowKey: "main", payload: { submissions: 1 }, updatedAt: now,
        });
      });
    }
    expect(await t.mutation(internal.operations.reports.cleanup.expireReadyJobs, {}))
      .toEqual({ expired: 50 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const cleaned = await t.run(async (ctx) =>
      await Promise.all(jobIds.map(jobId => ctx.db.get(jobId))),
    );
    expect(cleaned).toHaveLength(51);
    for (const job of cleaned) {
      expect(job).toMatchObject({ status: "expired", cleanupPending: false });
      expect(job?.cleanupCompletedAt).toBeTypeOf("number");
    }
    expect(await t.mutation(internal.operations.reports.cleanup.purgeExpiredMetadata, {}))
      .toEqual({ examined: 50, purged: 50 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const remaining = await t.run(async (ctx) =>
      await Promise.all(jobIds.map(jobId => ctx.db.get(jobId))),
    );
    expect(remaining.every(job => job === null)).toBe(true);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
