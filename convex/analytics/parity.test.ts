// @vitest-environment node
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/analytics-parity.mjs";
import { differences, coverageFailures } from "../../scripts/analytics-parity-core.mjs";
import { internal } from "../_generated/api";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { ordinaryParityDefinitions } from "./parity";

vi.mock("./registry", () => {
  const definitions = [
    { id: "api.metric", page: null }, { id: "api.metric.next", page: null }, { id: "api.metric.raw", page: null },
    { id: "people.active", page: "people" }, { id: "people.next", page: "people" },
  ].map(definition => ({ ...definition, day: "business", parseFilters: async (_ctx: unknown, raw: unknown) => raw,
    live: { name: "test:live", args: () => ({}) } }));
  return { listReportDefinitions: () => definitions, getReportDefinition: (id: string) => {
    const definition = definitions.find(d => d.id === id);
    if (!definition) throw new Error(`Unknown analytics report ${id}`);
    return definition;
  } };
});

const requestedRange = { kind: "preset", preset: "yesterday" };
const resolved = { fromMs: 1, toMs: 2, startDate: "2026-10-01", endDateInclusive: "2026-10-01",
  timeZone: "America/Tegucigalpa", dayStartHour: 1 };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parity-test-"));
  vi.stubEnv("CONVEX_DEPLOY_KEY", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function cli(reference: unknown, answer: unknown, options: { missing?: boolean; candidate?: boolean; incomplete?: boolean } = {}) {
  const runner = vi.fn((name: string, args: Record<string, unknown>) => {
    if (name === "analytics/parity:requiredReports") return ["people.active"];
    if (name === "analytics/parity:identity") return { subject: "owner" };
    if (name === "analytics/parity:plan") return options.missing ? [] : ["people.active", ...(options.candidate ? ["people.raw"] : [])].map(reportId => ({
      reportId, liveName: "test:live", liveArgsJson: "{}", filtersJson: args.filtersJson, range: resolved,
    }));
    if (name === "test:live") return reference;
    if (name === "analytics/parity:runBudgeted") return {
      status: options.incomplete ? "incomplete" : "complete", error: "budget exhausted", active: answer, candidate: options.candidate ? reference : null,
      differences: options.candidate ? differences(answer, reference) : [],
      usage: { attempts: [{ at: Date.now(), seconds: 0.01, retry: false }], queries: 1, seconds: 0.01,
        retries: 0, builds: 1, discarded: 0, repeated: 0 }, limitation: "clock/context not frozen",
    };
    throw new Error(`Unexpected ${name}`);
  });
  const argv = ["people", "--dev", "--tenant", "tenant", "--range", "yesterday", "--budget-file", join(dir, "budget.json")];
  if (options.candidate) argv.push("--active", "people.active", "--candidate", "people.raw");
  return { run: (extra: string[] = []) => main([...argv, ...extra], runner), runner };
}

describe("parity verification gate self-tests", () => {
  it("fails a deliberately wrong aggregate", () => {
    expect(cli({ count: 41 }, { count: 42 }).run()).toBe(1);
  });
  it("fails a one-minor-unit difference on a large balance", () => {
    expect(cli({ amountMinor: 10_000_000 }, { amountMinor: 10_000_001 }).run()).toBe(1);
    expect(cli({ count: 10_000_000 }, { count: 10_000_001 }).run()).toBe(1);
  });
  it("fails a capped reference without querying the warehouse", () => {
    const test = cli({ partial: true, count: 4 }, { count: 4 });
    expect(test.run()).toBe(1);
    expect(test.runner.mock.calls.some(([name]) => name === "analytics/parity:runBudgeted")).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("incomplete verification"));
    expect(cli({ nested: { attendanceCountsPartial: true } }, {}).run()).toBe(1);
    expect(cli({ truncated: true }, {}).run()).toBe(1);
  });
  it("fails a missing required panel", () => {
    expect(cli({ count: 4 }, { count: 4 }, { missing: true }).run()).toBe(1);
    expect(coverageFailures([{ reportId: "missing", range: requestedRange, filters: {} }], [])).toHaveLength(1);
  });
  it("passes exact answers and tolerates only fractional derived values", () => {
    expect(cli({ count: 4 }, { count: 4 }).run()).toBe(0);
    expect(differences({ conversionRate: 0.1234567 }, { conversionRate: 0.12345671 })).toEqual([]);
    expect(differences({ conversionRate: 1e-9 }, { conversionRate: 2e-9 })).toHaveLength(1);
    expect(differences({ amountMinor: 0.1234567 }, { amountMinor: 0.12345671 })).toHaveLength(1);
    expect(differences({ count: 0.1234567 }, { count: 0.12345671 })).toHaveLength(1);
  });
  it("requires every range and member filter, including explicit coverage", () => {
    const test = cli({ count: 4 }, { count: 4 });
    expect(test.run(["--range", "last_month", "--filters", '{"memberId":"A"}', "--filters", '{"memberId":"B"}'])).toBe(0);
    expect(test.runner.mock.calls.filter(([name]) => name === "analytics/parity:runBudgeted")).toHaveLength(4);
    const file = join(dir, "coverage.json");
    writeFileSync(file, JSON.stringify([{ reportId: "people.missing", range: "yesterday", filters: { memberId: "A" } }]));
    expect(test.run(["--coverage", file])).toBe(1);
  });
  it("compares explicit candidate and active ids", () => {
    const test = cli({ count: 4 }, { count: 4 }, { candidate: true });
    expect(test.run()).toBe(0);
    expect(test.runner).toHaveBeenCalledWith("analytics/parity:runBudgeted", expect.objectContaining({
      reportId: "people.active", candidateId: "people.raw",
    }), []);
    expect(cli({ count: 4 }, { count: 5 }, { candidate: true }).run()).toBe(1);
  });
  it("shares its hourly ledger between invocations and stops before exceeding it", () => {
    const test = cli({ count: 4 }, { count: 4 });
    expect(test.run(["--max-queries", "1"])).toBe(0);
    expect(test.run(["--max-queries", "1"])).toBe(1);
    expect(test.runner.mock.calls.filter(([name]) => name === "analytics/parity:runBudgeted")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "budget.json"), "utf8"))).toHaveLength(1);
  });
  it("fails on incomplete warehouse verification and preserves its query usage", () => {
    const test = cli({}, {}, { incomplete: true });
    expect(test.run()).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "budget.json"), "utf8"))).toHaveLength(1);
  });
  it("prevents a second local comparison process", () => {
    writeFileSync(join(dir, "budget.json.lock"), "12345");
    const test = cli({}, {});
    expect(test.run()).toBe(1);
    expect(test.runner).not.toHaveBeenCalled();
  });
});

it("excludes page-null .next and .raw twins from ordinary API parity, but permits explicit comparisons", async () => {
  expect(ordinaryParityDefinitions("api").map(d => d.id)).toEqual(["api.metric"]);
  expect(ordinaryParityDefinitions("people").map(d => d.id)).toEqual(["people.active", "people.next"]);
  const t = convexTest({ schema, modules: convexTestModules });
  const tenantId = await t.run(async ctx => {
    const tenantId = await ctx.db.insert("tenants", { companyName: "Parity", contactEmail: "x@example.invalid", workosOrgId: "org",
      status: "active", inviteExpiresAt: 0, createdBy: "test" });
    const owner = await ctx.db.insert("users", { tenantId, workosUserId: "owner", email: "x@example.invalid", role: "tenant_master", isActive: true });
    await ctx.db.patch("tenants", tenantId, { tenantOwnerId: owner });
    return tenantId;
  });
  const args = { tenantId, page: "api" as const, range: { kind: "preset" as const, preset: "yesterday" as const }, timeZone: "America/Tegucigalpa" };
  expect((await t.query(internal.analytics.parity.plan, args)).map(item => item.reportId)).toEqual(["api.metric"]);
  expect((await t.query(internal.analytics.parity.plan, { ...args, reportIds: ["api.metric", "api.metric.raw"] })).map(item => item.reportId))
    .toEqual(["api.metric", "api.metric.raw"]);
});

describe("analytics:parity arguments", () => {
  it("refuses a flag that needs a value without one", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const argv of [["people", "--max-queries"], ["people", "--candidate", "--range", "yesterday"], ["people", "--coverage"]])
      expect(main(argv, () => { throw new Error("must not run"); })).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Missing a value for"));
    error.mockRestore();
  });
});
