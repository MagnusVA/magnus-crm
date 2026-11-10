// @vitest-environment node
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { MAX_ROWS_JSON_CHARS } from "./results";

// The Node build path end to end: `runReport` → `finalizeInNode` → the
// context query → `complete`, against stubbed ClickHouse responses. The two
// definitions here stand in for the real Node-built reports.
vi.mock("./registry", async () => {
  const { nodeFinalize } = await import("./definition");
  type Rows = Record<string, Array<Record<string, unknown>>>;
  const base = {
    page: null,
    roles: ["tenant_master"] as const,
    day: "business" as const,
    parseFilters: async () => ({}),
    live: { name: "test:live", args: () => ({}) },
  };
  // Needs the rows first: its context reads the users the rows name.
  const fromRows = {
    keys: (rows: Rows) => [...new Set(rows.calls.map((row) => String(row.closer_id)))],
    context: async (ctx: QueryCtx, input: { tenantId: Id<"tenants"> }, keys: readonly string[]) => {
      const users = await Promise.all(keys.map((key) => {
        const id = ctx.db.normalizeId("users", key);
        return id ? ctx.db.get("users", id) : null;
      }));
      return { closers: users.flatMap((user) => (user?.tenantId === input.tenantId ? [user.email] : [])) };
    },
    build: (input: { rows: Rows; context: { closers: string[] } }) => ({
      calls: input.rows.calls.length,
      closers: input.context.closers,
      last: input.rows.calls.at(-1)?.id ?? null,
    }),
  };
  // No keys: its context loads first, and the SQL uses it.
  const contextFirst = {
    context: async () => ({ workerIds: ["w1", "w2"] }),
    build: (input: { rows: Rows; context: { workerIds: string[] } }) => ({
      captures: input.rows.captures.length,
      workerIds: input.context.workerIds,
    }),
  };
  const definitions = [
    { ...base, id: "test.from_rows", sql: () => ({ calls: { sql: "SELECT calls", params: {} } }),
      node: fromRows, finalize: nodeFinalize(fromRows as never) },
    { ...base, id: "test.context_first",
      sql: (_input: unknown, context?: { workerIds: string[] }) => ({
        captures: { sql: "SELECT captures", params: { member_worker_ids: context?.workerIds ?? [] } },
      }),
      node: contextFirst, finalize: nodeFinalize(contextFirst as never) },
  ];
  return {
    getReportDefinition: (id: string) => {
      const found = definitions.find((definition) => definition.id === id);
      if (!found) throw new Error(`Unknown analytics report ${id}.`);
      return found;
    },
    findReportDefinition: (id: string) => definitions.find((definition) => definition.id === id) ?? null,
    listReportDefinitions: () => definitions,
  };
});

type Call = { url: URL; sql: string };

function stubClickHouse(rowsFor: (call: Call) => unknown[] | string) {
  vi.stubEnv("CLICKHOUSE_URL", "https://clickhouse.example:8443");
  vi.stubEnv("CLICKHOUSE_USER", "magnus_app");
  vi.stubEnv("CLICKHOUSE_PASSWORD", "secret");
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: { body?: string }) => {
    const call = { url: new URL(String(input)), sql: String(init?.body ?? "") };
    calls.push(call);
    if (call.sql.includes("analytics.watermark")) {
      return new Response(JSON.stringify({ data: [{ watermark: 5_000, beats: 3 }] }));
    }
    const rows = rowsFor(call);
    return new Response(typeof rows === "string" ? rows : JSON.stringify({ data: rows }));
  });
  return calls;
}

async function setup(reportId: string) {
  const t = convexTest({ schema, modules: convexTestModules });
  const ids = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Node", contactEmail: "node@example.invalid", workosOrgId: "org_node",
      status: "active", inviteExpiresAt: Date.now() + 60_000, createdBy: "test",
    });
    const otherTenant = await ctx.db.insert("tenants", {
      companyName: "Other", contactEmail: "other@example.invalid", workosOrgId: "org_other",
      status: "active", inviteExpiresAt: Date.now() + 60_000, createdBy: "test",
    });
    const closer = await ctx.db.insert("users", {
      tenantId, workosUserId: "c1", email: "closer@example.invalid", role: "closer", isActive: true,
    });
    const foreign = await ctx.db.insert("users", {
      tenantId: otherTenant, workosUserId: "c2", email: "foreign@example.invalid", role: "closer", isActive: true,
    });
    const resultId = await ctx.db.insert("analyticsResults", {
      tenantId, reportId, argsKey: "{}", filtersJson: "{}",
      range: { kind: "custom", startDate: "2026-10-01", endDateInclusive: "2026-10-31" },
      timeZone: "America/Tegucigalpa", dayStartHour: 1, status: "pending",
      run: { id: "run1", watermark: 5_000, startedAt: Date.now() }, lastRequestedAt: Date.now(),
    });
    return { tenantId, closer, foreign, resultId };
  });
  return { t, ...ids };
}

async function stored(fixture: Awaited<ReturnType<typeof setup>>) {
  return await fixture.t.run(async (ctx) => {
    const row = (await ctx.db.get("analyticsResults", fixture.resultId))!;
    const ids = row.payloadId ? [row.payloadId, ...(row.payloadPartIds ?? [])] : [];
    const parts = await Promise.all(ids.map((id: Id<"analyticsPayloads">) => ctx.db.get("analyticsPayloads", id)));
    return { row, json: parts.map((part) => part!.json).join("") };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the Node build path", () => {
  it("answers a report whose rows are over the mutation's 4M-character cap", async () => {
    const fixture = await setup("test.from_rows");
    // 60,000 calls of about 90 characters each: past MAX_ROWS_JSON_CHARS.
    const rows = Array.from({ length: 60_000 }, (_, index) => ({
      id: `call-${index}`, closer_id: index % 2 === 0 ? fixture.closer : fixture.foreign, note: "x".repeat(40),
    }));
    expect(JSON.stringify({ calls: rows }).length).toBeGreaterThan(MAX_ROWS_JSON_CHARS);
    stubClickHouse(() => rows);

    await fixture.t.action(internal.analytics.run.runReport, { resultId: fixture.resultId, runId: "run1" });

    const { row, json } = await stored(fixture);
    expect(row.status).toBe("ready");
    expect(row.answer?.watermark).toBe(5_000);
    // The other tenant's user is named in the rows but never read.
    expect(JSON.parse(json)).toEqual({ calls: 60_000, closers: ["closer@example.invalid"], last: "call-59999" });
  });

  it("fails with the too-large message past the Node rows budget", async () => {
    const fixture = await setup("test.from_rows");
    stubClickHouse(() => `{"data":[${'{"id":"x","closer_id":"y"},'.repeat(1_000_000)}{"id":"z","closer_id":"y"}]}`);

    await fixture.t.action(internal.analytics.run.runReport, { resultId: fixture.resultId, runId: "run1" });

    const { row } = await stored(fixture);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toBe("This range is too large to show. Choose a shorter range.");
  });

  it("loads a keyless context before the SQL and passes it in", async () => {
    const fixture = await setup("test.context_first");
    const calls = stubClickHouse(() => [{ id: "c1" }, { id: "c2" }]);

    await fixture.t.action(internal.analytics.run.runReport, { resultId: fixture.resultId, runId: "run1" });

    const { row, json } = await stored(fixture);
    expect(row.status).toBe("ready");
    expect(JSON.parse(json)).toEqual({ captures: 2, workerIds: ["w1", "w2"] });
    const query = calls.find((call) => call.sql === "SELECT captures")!;
    expect(query.url.searchParams.get("param_member_worker_ids")).toBe("['w1','w2']");
  });
});
