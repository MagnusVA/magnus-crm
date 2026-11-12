import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Infer } from "convex/values";
import {
  callInsightsHarness,
  gatewayFetch,
} from "../../tests/callInsightsHarness";
import { queueRead } from "./trigger";
import { summaryValidator } from "./reports";
import type { ItemFact } from "./access";

const summary = makeFunctionReference<
  "query",
  { days: 30 | 90 },
  Infer<typeof summaryValidator>
>("callInsights/reports:summary");
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

async function fixture() {
  const f = await callInsightsHarness();
  vi.stubGlobal("fetch", gatewayFetch().fetchImpl);
  await f.t.run((ctx) =>
    queueRead(ctx, {
      recordingId: f.recordingId,
      trigger: "recording_matched",
    }),
  );
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  const facts = await f.t.run((ctx) =>
    ctx.db.query("callInsightFacts").take(10),
  );
  const header = facts.find((row) => row.kind === "call");
  const objection = facts.find(
    (row): row is ItemFact => row.kind === "objection",
  );
  const income = facts.find((row): row is ItemFact => row.kind === "income");
  if (!header || header.kind !== "call" || !objection || !income)
    throw new Error("Missing test facts");
  return { ...f, header, objection, income };
}

describe("summary authorization", () => {
  it.each([
    "owner",
    "admin",
    "closer",
    "other",
    "generator",
    "foreign",
  ] as const)("checks %s", async (role) => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
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
    });
    const clients = {
      ...f,
      generator: f.t.withIdentity({ subject: "user_gen", org_id: "org_test" }),
      foreign: f.t.withIdentity({
        subject: "user_foreign",
        org_id: "org_foreign",
      }),
    };
    const result = await clients[role].query(summary, { days: 30 });
    if (role === "owner" || role === "admin")
      expect(result?.coverage).toMatchObject({ matched: 1, read: 1 });
    else if (role === "foreign")
      expect(result?.coverage).toMatchObject({ matched: 0, read: 0 });
    else expect(result).toBeNull();
  });
});

describe("summary counting", () => {
  it("counts a category once per call and unresolved beats unknown and resolved", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...item } = f.objection;
      void _id;
      void _creationTime;
      await ctx.db.patch("callInsightFacts", f.objection._id, {
        resolution: "resolved",
      });
      await ctx.db.insert("callInsightFacts", {
        ...item,
        key: "objection:extra",
        resolution: "unknown",
        check: "restored",
      });
      await ctx.db.insert("callInsightFacts", {
        ...item,
        key: "objection:extra2",
        resolution: "unresolved",
      });
      await ctx.db.patch("callInsightFacts", f.header._id, {
        expectedItemCount: 4,
      });
    });
    const result = await f.owner.query(summary, { days: 30 });
    expect(result?.coverage).toMatchObject({ matched: 1, read: 1 });
    expect(result?.objections).toEqual([
      {
        category: "partner",
        label: "Partner",
        calls: 1,
        primaryCalls: 1,
        resolved: 0,
        unresolved: 1,
        unknown: 0,
      },
    ]);
    expect(result?.incomeBands).toEqual([
      {
        kind: "personal_income",
        label: "Personal income",
        band: "b5000",
        calls: 1,
      },
    ]);
    expect(result?.capped).toBe(false);
  });

  it("excludes unsure and unchecked items but includes them in publication completeness", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch("callInsightFacts", f.objection._id, {
        check: "unsure",
      });
      await ctx.db.patch("callInsightFacts", f.income._id, {
        check: "unchecked",
      });
    });
    expect(await f.owner.query(summary, { days: 30 })).toMatchObject({
      coverage: { read: 1 },
      objections: [],
      incomeBands: [],
    });
  });

  it("does not count or aggregate an incomplete or mismatched revision", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch("callInsightFacts", f.income._id, {
        publicationRevision: 999,
      }),
    );
    expect(await f.owner.query(summary, { days: 30 })).toMatchObject({
      coverage: { matched: 1, read: 0 },
      objections: [],
      incomeBands: [],
    });
  });

  it("counts only current income and merges conflicting bands per call and kind", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...item } = f.income;
      void _id;
      void _creationTime;
      await ctx.db.insert("callInsightFacts", {
        ...item,
        key: "income:target",
        scenario: "target",
        band: "b20000",
      });
      await ctx.db.insert("callInsightFacts", {
        ...item,
        key: "income:other",
        scenario: "current",
        band: "b10000",
        check: "restored",
      });
      await ctx.db.patch("callInsightFacts", f.header._id, {
        expectedItemCount: 4,
      });
    });
    expect((await f.owner.query(summary, { days: 30 }))?.incomeBands).toEqual([
      {
        kind: "personal_income",
        label: "Personal income",
        band: "spans_bands",
        calls: 1,
      },
    ]);
  });

  it("tracks coverage reasons and ignores inactive calls", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch("callInsightFacts", f.header._id, {
        latestStatus: "waiting",
        reasonCode: "cap_reached",
        noShowTier: "review",
      }),
    );
    expect(await f.owner.query(summary, { days: 30 })).toMatchObject({
      coverage: { read: 1, waiting: 1 },
      noShowTiers: { review: 1 },
    });
    await f.t.run((ctx) =>
      ctx.db.patch("callInsightFacts", f.header._id, {
        latestStatus: "skipped",
        reasonCode: "other_prospect",
      }),
    );
    expect(
      (await f.owner.query(summary, { days: 30 }))?.coverage.skippedByReason,
    ).toEqual({ other_prospect: 1 });
    await f.t.run((ctx) =>
      ctx.db.patch("callInsightFacts", f.header._id, {
        latestStatus: "failed",
        reasonCode: "refused",
      }),
    );
    expect((await f.owner.query(summary, { days: 30 }))?.coverage.failed).toBe(
      1,
    );
    await f.t.run((ctx) =>
      ctx.db.patch("callInsightFacts", f.header._id, { active: false }),
    );
    expect(await f.owner.query(summary, { days: 30 })).toMatchObject({
      coverage: { matched: 0, read: 0 },
      objections: [],
      incomeBands: [],
      noShowTiers: {},
    });
  });

  it("honors the 30 and 90 day windows and never needs private runs", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (const row of [f.header, f.objection, f.income])
        await ctx.db.patch("callInsightFacts", row._id, {
          scheduledAt: Date.now() - 60 * 86_400_000,
        });
      await ctx.db.delete("callInsightRuns", f.header.publishedRunId!);
    });
    expect((await f.owner.query(summary, { days: 30 }))?.coverage.matched).toBe(
      0,
    );
    expect((await f.owner.query(summary, { days: 90 }))?.coverage.read).toBe(1);
  });

  it("marks results capped when the header bound is hit", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...header } = f.header;
      void _id;
      void _creationTime;
      for (let i = 0; i < 999; i++)
        await ctx.db.insert("callInsightFacts", { ...header, active: false });
    });
    expect((await f.owner.query(summary, { days: 30 }))?.capped).toBe(true);
  });
});
