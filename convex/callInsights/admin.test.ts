import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  callInsightsHarness,
  decisionsAnswer,
  gatewayFetch,
} from "../../tests/callInsightsHarness";
import { queueRead } from "./trigger";
import { callInsightTables } from "./schema";
import { insertPipelineHealthAggregates } from "../reporting/pipelineHealthAggregates";

vi.mock("convex/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/server")>()),
  getServiceToken: vi.fn(async () => "test-token"),
}));
vi.mock("../auth", () => ({ authKit: { registerRoutes: () => {} } }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T18:00:00Z"));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const admin = api.callInsights.admin;

async function rejectedFixture() {
  const f = await callInsightsHarness();
  vi.stubGlobal(
    "fetch",
    gatewayFetch({
      decisions: (body) =>
        decisionsAnswer(body, {
          noul: "result" in body.questions ? 0.95 : 0.1,
        }),
    }).fetchImpl,
  );
  await f.t.run((ctx) =>
    queueRead(ctx, {
      recordingId: f.recordingId,
      trigger: "recording_matched",
    }),
  );
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  const review = await f.t.run((ctx) =>
    ctx.db.query("callInsightItemReviews").first(),
  );
  if (!review) throw new Error("Missing test review");
  return { ...f, review };
}

describe("admin authorization", () => {
  it.each([
    "owner",
    "admin",
    "closer",
    "other",
    "generator",
    "foreign",
  ] as const)("checks %s for every mutation", async (role) => {
    const f = await rejectedFixture();
    const foreignTenant = await f.t.run(async (ctx) => {
      await ctx.db.insert("users", {
        tenantId: f.tenantId,
        workosUserId: "user_gen",
        email: "gen@example.com",
        role: "lead_generator",
        isActive: true,
      });
      const tenantId = await ctx.db.insert("tenants", {
        companyName: "Foreign",
        contactEmail: "foreign@example.com",
        workosOrgId: "org_foreign",
        status: "active",
        inviteExpiresAt: 0,
        createdBy: "test",
      });
      await ctx.db.insert("users", {
        tenantId,
        workosUserId: "user_foreign",
        email: "foreign@example.com",
        role: "tenant_master",
        isActive: true,
      });
      return tenantId;
    });
    const clients = {
      ...f,
      generator: f.t.withIdentity({ subject: "user_gen", org_id: "org_test" }),
      foreign: f.t.withIdentity({
        subject: "user_foreign",
        org_id: "org_foreign",
      }),
    };
    const client = clients[role];
    const allowed = role === "owner" || role === "admin";
    const jobId = await f.t.run((ctx) =>
      ctx.db.insert("callInsightJobs", {
        tenantId: f.tenantId,
        kind: "backfill",
        status: "running",
        ceilingMicroUsd: 1e6,
        spentMicroUsd: 0,
        estimateMicroUsd: 0,
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        createdByUserId: f.ownerId,
        createdAt: Date.now(),
      }),
    );
    const scoped = [
      () => client.mutation(admin.readAgain, { recordingId: f.recordingId }),
      () =>
        client.mutation(admin.reviewItem, {
          runId: f.review.runId,
          itemKey: f.review.itemKey,
          decision: "dismiss",
        }),
      () => client.mutation(admin.cancelJob, { jobId }),
    ];
    for (const action of scoped) {
      if (allowed) await expect(action()).resolves.not.toThrow();
      else await expect(action()).rejects.toThrow();
    }
    if (allowed || role === "foreign") {
      await client.mutation(admin.enable, {});
      await client.mutation(admin.updateSettings, { suggestions: "on" });
      const tenant = await f.t.run((ctx) =>
        ctx.db.get("tenants", role === "foreign" ? foreignTenant : f.tenantId),
      );
      expect(tenant?.callInsights?.suggestions).toBe("on");
    } else {
      await expect(client.mutation(admin.enable, {})).rejects.toThrow();
      await expect(
        client.mutation(admin.updateSettings, { mode: "on" }),
      ).rejects.toThrow();
    }
    if (!allowed)
      await expect(
        client.mutation(admin.startBackfill, {
          scope: "unread",
          ceilingUsd: 1,
        }),
      ).rejects.toThrow();
    else {
      // A fresh unmatched generation is already queued by readAgain, so no backfill is available.
      await expect(
        client.mutation(admin.startBackfill, {
          scope: "unread",
          ceilingUsd: 1,
        }),
      ).rejects.toThrow("nothing to read");
    }
  });
});

describe("settings", () => {
  it("enables with defaults and preserves Second opinion exactly", async () => {
    const f = await callInsightsHarness({ settings: null });
    const before = await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId));
    await f.admin.mutation(admin.enable, {});
    let tenant = await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId));
    expect(tenant?.secondOpinion).toEqual(before?.secondOpinion);
    expect(tenant?.callInsights).toMatchObject({
      mode: "shadow",
      suggestions: "hidden",
      amountPrefill: false,
      noShowCertain: false,
      monthlyCapUsd: 60,
      evalMonthlyUsd: 10,
      itemCheck: true,
    });
    await f.owner.mutation(admin.updateSettings, {
      mode: "off",
      monthlyCapUsd: 70,
      evalMonthlyUsd: 12,
      noShowWaitMinutes: 7,
    });
    await f.admin.mutation(admin.enable, {});
    tenant = await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId));
    expect(tenant?.callInsights).toMatchObject({
      mode: "shadow",
      monthlyCapUsd: 70,
      evalMonthlyUsd: 12,
      noShowWaitMinutes: 7,
    });
    expect(tenant?.secondOpinion).toEqual(before?.secondOpinion);
  });

  it.each([
    { monthlyCapUsd: 0 },
    { monthlyCapUsd: 10001 },
    { monthlyCapUsd: Number.NaN },
    { evalMonthlyUsd: -1 },
    { evalMonthlyUsd: 61 },
    { evalMonthlyUsd: Number.POSITIVE_INFINITY },
    { monthlyCapUsd: 5 },
    { noShowWaitMinutes: 6 },
  ])("rejects invalid settings %j", async (args) => {
    const f = await callInsightsHarness();
    await expect(
      f.owner.mutation(admin.updateSettings, args),
    ).rejects.toThrow();
  });

  it("allows manual visibility choices, validates the combined caps and unsets a wait", async () => {
    const f = await callInsightsHarness();
    await f.admin.mutation(admin.updateSettings, {
      suggestions: "on",
      noShowCertain: true,
      noShowWaitMinutes: 5,
      monthlyCapUsd: 1,
      evalMonthlyUsd: 0,
    });
    await f.owner.mutation(admin.updateSettings, { noShowWaitMinutes: null });
    expect(
      (await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId)))?.callInsights,
    ).toMatchObject({
      suggestions: "on",
      noShowCertain: true,
      monthlyCapUsd: 1,
      evalMonthlyUsd: 0,
      changedByUserId: f.ownerId,
    });
    expect(
      (await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId)))?.callInsights
        ?.noShowWaitMinutes,
    ).toBeUndefined();
  });
});

describe("reading and review", () => {
  it("rejects Read again after transcript deletion or expiry", async () => {
    const f = await callInsightsHarness();
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        transcriptDeletedAt: Date.now(),
      }),
    );
    await expect(
      f.owner.mutation(admin.readAgain, { recordingId: f.recordingId }),
    ).rejects.toThrow("transcript");
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        transcriptDeletedAt: undefined,
        transcriptExpiresAt: Date.now() - 1,
      }),
    );
    await expect(
      f.owner.mutation(admin.readAgain, { recordingId: f.recordingId }),
    ).rejects.toThrow("transcript");
  });

  it("restores and republishes once, retaining the restored check", async () => {
    const f = await rejectedFixture();
    const args = {
      runId: f.review.runId,
      itemKey: f.review.itemKey,
      decision: "restore" as const,
    };
    await f.admin.mutation(admin.reviewItem, args);
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await f.t.run((ctx) =>
      ctx.db.query("callInsightFacts").take(10),
    );
    expect(rows.filter((row) => row.kind !== "call")).toMatchObject([
      { key: f.review.itemKey, check: "restored" },
    ]);
    const header = rows.find((row) => row.kind === "call");
    await f.owner.mutation(admin.reviewItem, args);
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      (await f.t.run((ctx) => ctx.db.query("callInsightFacts").take(10))).find(
        (row) => row.kind === "call",
      ),
    ).toEqual(header);
    expect(
      await f.t.run((ctx) =>
        ctx.db.get("callInsightItemReviews", f.review._id),
      ),
    ).toMatchObject({ state: "restored", decidedByUserId: f.adminId });
  });

  it("dismisses without publishing and remains idempotent", async () => {
    const f = await rejectedFixture();
    const args = {
      runId: f.review.runId,
      itemKey: f.review.itemKey,
      decision: "dismiss" as const,
    };
    await f.admin.mutation(admin.reviewItem, args);
    const review = await f.t.run((ctx) =>
      ctx.db.get("callInsightItemReviews", f.review._id),
    );
    vi.setSystemTime(Date.now() + 1000);
    await f.owner.mutation(admin.reviewItem, args);
    expect(
      await f.t.run((ctx) =>
        ctx.db.get("callInsightItemReviews", f.review._id),
      ),
    ).toEqual(review);
  });
});

describe("backfill and upkeep", () => {
  it("starts a bounded job, rejects a competing job, and cancels idempotently", async () => {
    const f = await callInsightsHarness();
    await expect(
      f.owner.mutation(admin.startBackfill, {
        scope: "unread",
        ceilingUsd: 0.5,
      }),
    ).rejects.toThrow();
    await expect(
      f.owner.mutation(admin.startBackfill, {
        scope: "unread",
        ceilingUsd: 61,
      }),
    ).rejects.toThrow();
    const jobId = await f.admin.mutation(admin.startBackfill, {
      scope: "unread",
      ceilingUsd: 5,
    });
    await expect(
      f.owner.mutation(admin.startBackfill, { scope: "unread", ceilingUsd: 5 }),
    ).rejects.toThrow();
    await f.admin.mutation(admin.cancelJob, { jobId });
    await f.owner.mutation(admin.cancelJob, { jobId });
    expect(
      await f.t.run((ctx) => ctx.db.get("callInsightJobs", jobId)),
    ).toMatchObject({ status: "canceled", total: 1, skipped: 1 });
  });

  it("includes all ten tables in tenant cleanup and operational snapshots", async () => {
    const f = await callInsightsHarness();
    await f.t.run((ctx) =>
      ctx.db.insert("callInsightBudgets", {
        tenantId: f.tenantId,
        monthKey: "2026-11",
        reservedMicroUsd: 0,
        spentMicroUsd: 0,
        evalReservedMicroUsd: 0,
        evalSpentMicroUsd: 0,
        updatedAt: Date.now(),
      }),
    );
    const snapshot = await f.t.query(
      internal.testing.operationalData.getSnapshot,
      {},
    );
    for (const table of Object.keys(callInsightTables)) {
      expect(snapshot.operationalTables).toContain(table);
      expect(snapshot.counts).toHaveProperty(table);
    }
    await f.t.run(async (ctx) => {
      const deal = await ctx.db.get("opportunities", f.opportunityId);
      await insertPipelineHealthAggregates(ctx, deal!);
    });
    const result = await f.t.mutation(
      internal.admin.tenantsMutations.deleteTenantRuntimeDataBatch,
      { tenantId: f.tenantId },
    );
    for (const table of Object.keys(callInsightTables))
      expect(result.deletedCounts).toHaveProperty(table);
    expect(result.deletedCounts.callInsightBudgets).toBe(1);
  });
});
