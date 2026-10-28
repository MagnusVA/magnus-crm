import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { DAILY_MISS_BUDGET, DAY_MS } from "./results";
import { listReportDefinitions } from "./registry";
import { API_METRICS } from "./api/metrics";
import { hmacSha256Hex } from "../lib/webCrypto";
import { formatSqlParam } from "./clickhouse";

const metricsArgs = {
  reportId: "revenue.metrics",
  filters: {},
  range: { kind: "preset" as const, preset: "last_month" as const },
  timeZone: "America/Tegucigalpa",
};
// The key `request` builds for metricsArgs.
const metricsKey = '{"f":{"paymentType":null,"programId":null},"h":0,"r":{"kind":"preset","preset":"last_month"},"tz":"America/Tegucigalpa"}';

type ClickHouseCall = { url: URL; sql: string };

function stubClickHouse(respond: (call: ClickHouseCall) => { status?: number; body: unknown }) {
  vi.stubEnv("CLICKHOUSE_URL", "https://clickhouse.example:8443");
  vi.stubEnv("CLICKHOUSE_USER", "magnus_app");
  vi.stubEnv("CLICKHOUSE_PASSWORD", "secret");
  const calls: ClickHouseCall[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: { body?: string }) => {
    const call = { url: new URL(String(input)), sql: String(init?.body ?? "") };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  return calls;
}

function watermarkOr(watermark: number, rows: unknown[]) {
  return (call: ClickHouseCall) =>
    call.sql.includes("analytics.watermark")
      ? { body: { data: [{ watermark, beats: 3 }] } }
      : { body: { data: rows } };
}

async function createFixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const tenant = (name: string, org: string) =>
      ctx.db.insert("tenants", {
        businessDayAppliedVersion: 0,
        companyName: name,
        contactEmail: `${org}@example.invalid`,
        workosOrgId: org,
        status: "active",
        inviteExpiresAt: now + 60_000,
        createdBy: "test",
      });
    const tenantA = await tenant("Tenant A", "org_a");
    const tenantB = await tenant("Tenant B", "org_b");
    const user = (tenantId: Id<"tenants">, workosUserId: string, role: Doc<"users">["role"]) =>
      ctx.db.insert("users", {
        tenantId,
        workosUserId,
        email: `${workosUserId}@example.invalid`,
        role,
        isActive: true,
      });
    const adminA = await user(tenantA, "admin_a", "tenant_admin");
    await user(tenantA, "closer_a", "closer");
    await user(tenantB, "admin_b", "tenant_admin");
    return { tenantA, tenantB, adminA };
  });
  return {
    t,
    ...ids,
    adminA: t.withIdentity({ subject: "admin_a", org_id: "org_a" }),
    closerA: t.withIdentity({ subject: "closer_a", org_id: "org_a" }),
    adminB: t.withIdentity({ subject: "admin_b", org_id: "org_b" }),
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function insertResult(
  fixture: Fixture,
  { payload, ...overrides }: Partial<Doc<"analyticsResults">> & { tenantId: Id<"tenants">; payload?: string },
) {
  return await fixture.t.run(async (ctx) => {
    const payloadId = payload
      ? await ctx.db.insert("analyticsPayloads", { tenantId: overrides.tenantId, json: payload })
      : undefined;
    return await ctx.db.insert("analyticsResults", {
      reportId: "revenue.metrics",
      argsKey: metricsKey,
      filtersJson: '{"paymentType":null,"programId":null}',
      range: metricsArgs.range,
      timeZone: metricsArgs.timeZone,
      dayStartHour: 0,
      status: "ready",
      lastRequestedAt: Date.now(),
      ...(payloadId ? { payloadId } : {}),
      ...overrides,
    });
  });
}

async function setWatermark(fixture: Fixture, watermark: number) {
  await fixture.t.run(async (ctx) => {
    await ctx.db.insert("analyticsSync", { beatAt: Date.now(), watermark });
  });
}

async function scheduledCount(fixture: Fixture) {
  return await fixture.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").take(100)).length);
}

function payment(id: string, amountMinor: number, recordedAt: number) {
  return {
    id,
    creation_time_ms: recordedAt,
    tenant_id: "ignored",
    amount_minor: amountMinor,
    currency: "USD",
    payment_type: "pif",
    status: "verified",
    recorded_at_ms: recordedAt,
    origin: "closer_meeting",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("analytics reports", () => {
  it("checks the report's roles and never returns another tenant's answer", async () => {
    const fixture = await createFixture();
    await insertResult(fixture, { tenantId: fixture.tenantB, payload: '{"secret":true}' });

    await expect(fixture.t.query(api.analytics.reports.get, metricsArgs)).rejects.toThrow("Not authenticated");
    await expect(fixture.closerA.query(api.analytics.reports.get, metricsArgs)).rejects.toThrow(
      "Insufficient permissions",
    );
    await expect(fixture.closerA.mutation(api.analytics.reports.request, metricsArgs)).rejects.toThrow(
      "Insufficient permissions",
    );
    const own = await fixture.adminA.query(api.analytics.reports.get, metricsArgs);
    expect(own.state).toBe("missing");
    const other = await fixture.adminB.query(api.analytics.reports.get, metricsArgs);
    expect(other.payloadJson).toBe('{"secret":true}');
  });

  it("rejects unknown reports and filters from another table", async () => {
    const fixture = await createFixture();
    await expect(
      fixture.adminA.query(api.analytics.reports.get, { ...metricsArgs, reportId: "nope" }),
    ).rejects.toThrow("Unknown report");
    await expect(
      fixture.adminA.query(api.analytics.reports.get, {
        ...metricsArgs,
        filters: { programId: String(fixture.tenantA) },
      }),
    ).rejects.toThrow("Invalid filter");
  });

  it("inserts one row and schedules one run for concurrent requests of a key", async () => {
    const fixture = await createFixture();
    stubClickHouse(() => ({ body: { data: [] } }));
    await setWatermark(fixture, 1_000);

    const first = await fixture.adminA.mutation(api.analytics.reports.request, metricsArgs);
    const second = await fixture.adminA.mutation(api.analytics.reports.request, metricsArgs);

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    const rows = await fixture.t.run(async (ctx) => ctx.db.query("analyticsResults").take(100));
    expect(rows).toHaveLength(1);
    expect(rows[0].argsKey).toBe(metricsKey);
    expect(await scheduledCount(fixture)).toBe(1);
  });

  it("queues a new key past the daily budget without calling ClickHouse", async () => {
    const fixture = await createFixture();
    const calls = stubClickHouse(() => ({ body: { data: [] } }));
    const now = Date.now();
    for (let index = 0; index < DAILY_MISS_BUDGET; index += 1) {
      await insertResult(fixture, { tenantId: fixture.tenantA, argsKey: `other-${index}`, missedAt: now - 1_000 });
    }

    const result = await fixture.adminA.mutation(api.analytics.reports.request, metricsArgs);

    expect(result.started).toBe(false);
    const state = await fixture.adminA.query(api.analytics.reports.get, metricsArgs);
    expect(state.state).toBe("queued");
    expect(await scheduledCount(fixture)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("keeps showing the previous answer while the current sync's run is pending", async () => {
    const fixture = await createFixture();
    stubClickHouse(() => ({ body: { data: [] } }));
    const now = Date.now();
    const lastMonth = await fixture.t.run(async () => {
      const { resolveAnalyticsRange } = await import("../../lib/analyticsRange");
      return resolveAnalyticsRange(metricsArgs.range, { timeZone: metricsArgs.timeZone, dayStartHour: 0 }, now);
    });
    await insertResult(fixture, {
      tenantId: fixture.tenantA,
      payload: '{"old":true}',
      answer: {
        watermark: 1_000,
        startDate: lastMonth.startDate,
        endDateInclusive: lastMonth.endDateInclusive,
        completedAt: now - DAY_MS,
      },
    });
    await setWatermark(fixture, 2_000);

    const result = await fixture.adminA.mutation(api.analytics.reports.request, metricsArgs);
    const state = await fixture.adminA.query(api.analytics.reports.get, metricsArgs);

    expect(result.started).toBe(true);
    expect(state.state).toBe("pending");
    expect(state.payloadJson).toBe('{"old":true}');
    expect(state.answer?.watermark).toBe(1_000);
  });

  it("answers from ClickHouse rows in the reader's own shape, for the caller's tenant only", async () => {
    const fixture = await createFixture();
    const recordedAt = Date.now() - 40 * DAY_MS;
    const calls = stubClickHouse(watermarkOr(5_000, [payment("p1", 10_000, recordedAt), payment("p2", 2_500, recordedAt)]));
    await setWatermark(fixture, 5_000);

    await fixture.adminA.mutation(api.analytics.reports.request, metricsArgs);
    await fixture.t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await fixture.adminA.query(api.analytics.reports.get, metricsArgs);

    expect(state.state).toBe("ready");
    expect(state.answer?.watermark).toBe(5_000);
    const payload = JSON.parse(state.payloadJson!);
    expect(payload.revenue.finalRevenueMinor).toBe(12_500);
    expect(payload.revenue.totalDeals).toBe(2);
    expect(payload.isPaymentDataTruncated).toBe(false);
    const reportCall = calls.find((call) => call.sql.includes("analytics.payments"))!;
    expect(reportCall.url.searchParams.get("param_tenant_id")).toBe(fixture.tenantA);
    expect(reportCall.url.searchParams.get("SQL_tenant_id")).toBe(fixture.tenantA);
  });

  it("keeps the last answer and a safe message when ClickHouse fails", async () => {
    const fixture = await createFixture();
    stubClickHouse((call) =>
      call.sql.includes("analytics.watermark")
        ? { body: { data: [{ watermark: 9_000, beats: 1 }] } }
        : { status: 500, body: "Code: 47. DB::Exception: Unknown expression identifier `secret_column`" },
    );
    await insertResult(fixture, {
      tenantId: fixture.tenantA,
      payload: '{"old":true}',
      answer: { watermark: 1_000, startDate: "2000-01-01", endDateInclusive: "2000-01-31", completedAt: 1 },
    });
    await setWatermark(fixture, 9_000);

    await fixture.adminA.mutation(api.analytics.reports.request, metricsArgs);
    await fixture.t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await fixture.adminA.query(api.analytics.reports.get, metricsArgs);

    expect(state.state).toBe("failed");
    expect(state.payloadJson).toBe('{"old":true}');
    expect(state.errorMessage).not.toContain("secret_column");
  });

  it("reruns keys opened in the last 7 days after a sync and deletes keys idle for 14", async () => {
    const fixture = await createFixture();
    stubClickHouse(watermarkOr(7_000, []));
    await setWatermark(fixture, 1_000);
    const now = Date.now();
    const recent = await insertResult(fixture, { tenantId: fixture.tenantA, lastRequestedAt: now - DAY_MS });
    const old = await insertResult(fixture, { tenantId: fixture.tenantA, argsKey: "old", lastRequestedAt: now - 8 * DAY_MS });
    const expired = await insertResult(fixture, { tenantId: fixture.tenantA, argsKey: "expired", lastRequestedAt: now - 15 * DAY_MS });

    await fixture.t.action(internal.analytics.run.runPostSyncBatch, {});
    await fixture.t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await fixture.t.run(async (ctx) => ({
      recent: await ctx.db.get("analyticsResults", recent),
      old: await ctx.db.get("analyticsResults", old),
      expired: await ctx.db.get("analyticsResults", expired),
      sync: await ctx.db.query("analyticsSync").first(),
    }));
    expect(rows.recent?.status).toBe("ready");
    expect(rows.recent?.answer?.watermark).toBe(7_000);
    expect(rows.old?.answer).toBeUndefined();
    expect(rows.expired).toBeNull();
    expect(rows.sync?.watermark).toBe(7_000);
    expect(rows.sync?.lastBatchAt).toBeDefined();
  });

  it("skips the batch when the sync added nothing", async () => {
    const fixture = await createFixture();
    const calls = stubClickHouse(watermarkOr(1_000, []));
    await setWatermark(fixture, 1_000);
    await insertResult(fixture, { tenantId: fixture.tenantA });

    await fixture.t.action(internal.analytics.run.runPostSyncBatch, {});

    expect(calls).toHaveLength(1);
  });
});

describe("analytics budget and batch", () => {
  it("counts every run of a key that keeps failing against the budget", async () => {
    const fixture = await createFixture();
    const calls = stubClickHouse(() => ({ body: { data: [] } }));
    const now = Date.now();
    await insertResult(fixture, {
      tenantId: fixture.tenantA,
      argsKey: "failing",
      status: "failed",
      missedAt: now - 1_000,
      missWindowStart: now - DAY_MS / 2,
      missCount: DAILY_MISS_BUDGET,
    });

    const result = await fixture.adminA.mutation(api.analytics.reports.request, metricsArgs);

    expect(result.started).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("replaces a run for an older sync instead of losing the new sync's refresh", async () => {
    const fixture = await createFixture();
    stubClickHouse(watermarkOr(7_000, []));
    await setWatermark(fixture, 1_000);
    const resultId = await insertResult(fixture, {
      tenantId: fixture.tenantA,
      status: "pending",
      run: { id: "older", watermark: 1_000, startedAt: Date.now() },
    });

    await fixture.t.action(internal.analytics.run.runPostSyncBatch, {});
    await fixture.t.finishAllScheduledFunctions(vi.runAllTimers);
    await fixture.t.mutation(internal.analytics.results.complete, {
      resultId,
      runId: "older",
      watermark: 1_000,
      range: { startDate: "2000-01-01", endDateInclusive: "2000-01-31", fromMs: 0, toMs: 1, timeZone: "UTC", dayStartHour: 0 },
      rowsJson: '{"payments":[]}',
    });

    const row = await fixture.t.run(async (ctx) => ctx.db.get("analyticsResults", resultId));
    expect(row?.answer?.watermark).toBe(7_000);
  });

  it("deletes an idle key's answer with it", async () => {
    const fixture = await createFixture();
    stubClickHouse(watermarkOr(1_000, []));
    await setWatermark(fixture, 1_000);
    await insertResult(fixture, { tenantId: fixture.tenantA, payload: "{}", lastRequestedAt: Date.now() - 15 * DAY_MS });

    await fixture.t.action(internal.analytics.run.runPostSyncBatch, { force: true });

    const left = await fixture.t.run(async (ctx) => ({
      results: (await ctx.db.query("analyticsResults").take(10)).length,
      payloads: (await ctx.db.query("analyticsPayloads").take(10)).length,
    }));
    expect(left).toEqual({ results: 0, payloads: 0 });
  });

  it("alerts when no sync has ended 8 hours after the first heartbeat", async () => {
    const fixture = await createFixture();
    stubClickHouse(() => ({ body: { data: [] } }));
    await fixture.t.mutation(internal.analytics.sync.beat, {});
    vi.advanceTimersByTime(9 * 60 * 60 * 1000);
    await fixture.t.mutation(internal.analytics.sync.beat, {});
    const sync = await fixture.t.run(async (ctx) => ctx.db.query("analyticsSync").first());
    expect(sync?.staleReportedAt).toBeDefined();
  });
});

describe("ClickHouse parameters", () => {
  it("escapes backslashes and control characters, in strings and arrays", () => {
    expect(formatSqlParam("a\\b\tc\nd")).toBe("a\\\\b\\tc\\nd");
    expect(formatSqlParam(["it's", "x\ty"])).toBe("['it\\'s','x\\ty']");
    expect(formatSqlParam(null)).toBe("\\N");
    expect(() => formatSqlParam(Number.NaN)).toThrow();
  });
});

describe("report templates", () => {
  const range = {
    startDate: "2026-09-01",
    endDateInclusive: "2026-09-30",
    fromMs: 1_788_242_400_123,
    toMs: 1_790_834_400_456,
    timeZone: "America/Tegucigalpa",
    dayStartHour: 1,
  };
  const sentinelFilters = new Proxy({} as Record<string, string>, {
    get: (_target, key) => (typeof key === "string" && key !== "then" ? "FILTER_SENTINEL" : undefined),
  });

  // Reports whose filters choose which queries run get real values, so every
  // query is checked; the rest get sentinels that must never reach the SQL.
  const sampleFilters: Record<string, Record<string, string>> = {
    "api.metrics": { metrics: API_METRICS.join(","), granularity: "day", group_by: "none" },
    // overview.dashboard runs the other kinds' queries.
    "overview.leaderboard": { kind: "qualifiers" },
  };

  for (const definition of listReportDefinitions()) {
    it(`${definition.id} filters every view by tenant and takes values only as parameters`, () => {
      const filters = sampleFilters[definition.id] ?? sentinelFilters;
      const queries = definition.sql({ tenantId: "TENANT_SENTINEL" as Id<"tenants">, filters, range });
      for (const [name, query] of Object.entries(queries)) {
        const views = query.sql.match(/\banalytics\.(?!watermark\b)\w+/g) ?? [];
        const tenantFilters = query.sql.match(/\btenant_id\s*=\s*\{tenant_id:String\}/g) ?? [];
        expect(views.length, `${name} reads a view`).toBeGreaterThan(0);
        expect(tenantFilters.length, `${name}: one tenant filter per view read`).toBeGreaterThanOrEqual(views.length);
        expect(query.sql).not.toMatch(/convex_app\.|FILTER_SENTINEL|TENANT_SENTINEL|1788242400123|1790834400456/);
        expect(query.params ?? {}).not.toHaveProperty("tenant_id");
      }
    });
  }
});

describe("Fivetran webhook", () => {
  beforeEach(() => {
    // convex/http.ts mounts AuthKit, which reads these at import.
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
    vi.stubEnv("WORKOS_API_KEY", "sk_test");
    vi.stubEnv("WORKOS_WEBHOOK_SECRET", "whsec_test");
    vi.stubEnv("FIVETRAN_WEBHOOK_SECRET", "whsec");
  });

  async function post(fixture: Fixture, body: unknown, secret = "whsec") {
    const raw = JSON.stringify(body);
    return await fixture.t.fetch("/analytics/fivetran", {
      method: "POST",
      body: raw,
      headers: { "X-Fivetran-Signature-256": (await hmacSha256Hex(secret, raw)).toUpperCase() },
    });
  }
  const syncEnd = {
    event: "sync_end",
    created: "2026-10-27T14:31:00.000Z",
    connector_id: "convex_prod",
    sync_id: "sync-1",
    data: { status: "SUCCESSFUL" },
  };

  it("rejects a bad signature and ignores Fivetran's test delivery", async () => {
    const fixture = await createFixture();

    expect((await post(fixture, syncEnd, "wrong")).status).toBe(401);
    expect((await post(fixture, { ...syncEnd, connector_id: "_connection_1" })).status).toBe(200);
    expect(await scheduledCount(fixture)).toBe(0);
  });

  it("starts one batch per successful sync, even when Fivetran retries the delivery", async () => {
    const fixture = await createFixture();

    expect((await post(fixture, syncEnd)).status).toBe(200);
    expect((await post(fixture, syncEnd)).status).toBe(200);
    expect((await post(fixture, { ...syncEnd, sync_id: "sync-2", created: "2026-10-27T20:31:00.000Z", data: { status: "FAILURE" } })).status).toBe(200);

    expect(await scheduledCount(fixture)).toBe(1);
    const sync = await fixture.t.run(async (ctx) => ctx.db.query("analyticsSync").first());
    expect(sync?.lastSyncEndedAt).toBe(Date.parse(syncEnd.created));
    expect(sync?.lastSyncStatus).toBe("FAILURE");
  });

  it("ignores a retried delivery of an older sync that arrives after a newer one", async () => {
    const fixture = await createFixture();
    const newer = { ...syncEnd, sync_id: "sync-new", created: "2026-10-27T20:31:00.000Z" };
    expect((await post(fixture, newer)).status).toBe(200);
    expect((await post(fixture, syncEnd)).status).toBe(200);

    expect(await scheduledCount(fixture)).toBe(1);
    const sync = await fixture.t.run(async (ctx) => ctx.db.query("analyticsSync").first());
    expect(sync?.lastSyncEndedAt).toBe(Date.parse(newer.created));
    expect(sync?.lastSyncId).toBe("sync-new");
  });
});
