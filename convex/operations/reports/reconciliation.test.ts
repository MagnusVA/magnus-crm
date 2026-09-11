import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import type { GenericDatabaseWriter, GenericDataModel } from "convex/server";
import { expect, it, vi } from "vitest";
import { internal } from "../../_generated/api";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { normalizeReportRange, REPORT_LEASE_MS, REPORT_UPLOAD_SETTLE_MS } from "./contracts";

it.each(["immediate", "late"] as const)("recovers an unattached %s upload without touching unrelated storage, then cleans it up", async (timing) => {
  vi.useFakeTimers();
  try {
    const t = convexTest({ schema, modules: convexTestModules });
    const now = Date.now();
    const jobId = await t.run(async (ctx) => {
      const tenantId = await ctx.db.insert("tenants", {
        companyName: "Reconciliation fixture",
        contactEmail: "fixture@example.com",
        workosOrgId: "org_reconciliation",
        status: "active",
        inviteExpiresAt: now + 60_000,
        createdBy: "test",
      });
      const userId = await ctx.db.insert("users", {
        tenantId,
        workosUserId: "user_reconciliation",
        email: "admin@example.com",
        role: "tenant_admin",
        isActive: true,
      });
      return await ctx.db.insert("operationsReportJobs", {
        tenantId,
        requestedByUserId: userId,
        purpose: "export",
        format: "summary_csv",
        reportKind: "lead-gen",
        range: normalizeReportRange({ reportKind: "lead-gen", input: { kind: "preset", preset: "today" }, now }),
        sourceFilter: "all",
        requestToken: "reconciliation-token",
        requestKey: "reconciliation-key",
        definitionVersion: "fixture-v1",
        status: "rendering",
        phase: "rendering",
        rowsProcessed: 0,
        pagesProcessed: 0,
        artifactCount: 0,
        checkpointSequence: 0,
        leaseGeneration: 1,
        leaseOwner: "crashing-worker",
        leaseExpiresAt: now + REPORT_LEASE_MS,
        retryCount: 0,
        queuedAt: now,
        createdAt: now,
        cleanupPending: false,
      });
    });
    const content = "name,count\nFixture,1\n";
    const reservation = await t.mutation(internal.operations.reports.jobs.reserveArtifact, {
      jobId, workerId: "crashing-worker", leaseGeneration: 1,
      expectedSequence: 0, commitKey: "reserve:1", partNumber: 1,
      filename: "report.csv", mimeType: "text/csv",
      expectedSha256: createHash("sha256").update(content).digest("base64"),
      expectedByteSize: new TextEncoder().encode(content).byteLength,
      rowCount: 1, ownershipToken: "reconciliation-owned-token",
    });
    if (reservation.kind === "stale") throw new Error("Reservation unexpectedly rejected.");
    if (timing === "late") {
      vi.setSystemTime(now + 2 * REPORT_LEASE_MS + 1);
      await t.run(async (ctx) => {
        await ctx.db.patch(jobId, { status: "queued", leaseOwner: undefined, leaseExpiresAt: undefined });
        // Exercise reservations persisted under the former two-minute deadline.
        await ctx.db.patch(reservation.artifactId, { reservationExpiresAt: now + 2 * REPORT_LEASE_MS });
      });
      await t.mutation(internal.operations.reports.cleanup.reconcileOrphanReservations, {});
      expect(await t.run(async (ctx) => ctx.db.get(reservation.artifactId))).toMatchObject({
        state: "reserved", reconciliationComplete: false,
        reservationExpiresAt: now + REPORT_UPLOAD_SETTLE_MS,
      });
      // The expired worker's store() completes after the old orphan scan deadline.
      vi.setSystemTime(now + 3 * REPORT_LEASE_MS);
    }
    const files = await t.run(async (ctx) => ({
      report: await ctx.storage.store(new Blob([content], { type: reservation.ownershipContentType })),
      // Same bytes and hash, different ownership token: never belongs to this job.
      unrelated: await ctx.storage.store(new Blob([content], { type: "text/csv; report-token=unrelated-token" })),
    }));
    // convex-test 0.0.57 omits Blob.type from storage metadata. Fill that
    // platform field while retaining its real store/hash/get/delete behavior.
    await t.run(async (ctx) => {
      const db: GenericDatabaseWriter<GenericDataModel> = ctx.db;
      await db.patch(files.report, { contentType: reservation.ownershipContentType });
      await db.patch(files.unrelated, { contentType: "text/csv; report-token=unrelated-token" });
    });
    // Simulate a crash after store() and before attachArtifact(), then recovery.
    vi.setSystemTime(now + REPORT_UPLOAD_SETTLE_MS + 1);
    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, { status: "queued", leaseOwner: undefined, leaseExpiresAt: undefined });
    });
    await t.mutation(internal.operations.reports.cleanup.reconcileOrphanReservations, {});
    const recovered = await t.run(async (ctx) => ({
      artifact: await ctx.db.get(reservation.artifactId),
      job: await ctx.db.get(jobId),
      report: await (await ctx.storage.get(files.report))?.text() ?? null,
      unrelated: await (await ctx.storage.get(files.unrelated))?.text() ?? null,
    }));
    expect(recovered.artifact).toMatchObject({ state: "attached", storageId: files.report, reconciliationComplete: true });
    expect(recovered.job?.artifactCount).toBe(1);
    expect(recovered.report).toBe(content);
    expect(recovered.unrelated).toBe(content);

    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, { status: "failed", phase: "cleanup", expiresAt: Date.now(), cleanupPending: true, cleanupNextAttemptAt: Date.now() });
    });
    // Artifacts, lifecycle checkpoint, then completion are separate bounded batches.
    for (let batch = 0; batch < 3; batch += 1) {
      await t.mutation(internal.operations.reports.cleanup.cleanupTerminalJobs, {});
    }
    const cleaned = await t.run(async (ctx) => ({
      artifact: await ctx.db.get(reservation.artifactId),
      job: await ctx.db.get(jobId),
      report: await (await ctx.storage.get(files.report))?.text() ?? null,
      unrelated: await (await ctx.storage.get(files.unrelated))?.text() ?? null,
    }));
    expect(cleaned.artifact).toBeNull();
    expect(cleaned.report).toBeNull();
    expect(cleaned.job?.cleanupPending).toBe(false);
    expect(cleaned.unrelated).toBe(content);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
