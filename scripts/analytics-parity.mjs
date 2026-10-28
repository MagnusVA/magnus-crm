#!/usr/bin/env node
// Compares each report on a page: the Convex reader against the ClickHouse
// path, on production, for the same range (docs/plans/clickhouse-reporting.md
// §12.1). Read-only on both sides. Run it right after a Fivetran sync, while
// ClickHouse is awake.
//
//   pnpm analytics:parity <page> --tenant <tenantId> [--range last_month]
//                         [--range 2026-09-01:2026-09-30] [--tz America/Tegucigalpa]
//                         [--filters '{"programId":"…"}'] [--dev]
//
// Pages: revenue, team, pipeline, leads, activity, reminders,
// slack_qualifications, sales_calls, booked_calls, qualifications, lead_gen,
// overview, my_activity, and api for the external API's metrics. With no --range it checks yesterday, last_month and
// last_90_days. Exits 1 when any report differs.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const page = args.find((arg) => !arg.startsWith("--"));
if (!page) {
  console.error("Usage: pnpm analytics:parity <page> [--range …] [--tz …] [--tenant …] [--filters …] [--dev]");
  process.exit(2);
}
function option(name) {
  const values = [];
  args.forEach((arg, index) => {
    if (arg === `--${name}` && args[index + 1]) values.push(args[index + 1]);
  });
  return values;
}
const deployment = args.includes("--dev") ? [] : ["--prod"];
const timeZone = option("tz")[0] ?? "America/Tegucigalpa";
const filtersJson = option("filters")[0];
const ranges = (option("range").length > 0 ? option("range") : ["yesterday", "last_month", "last_90_days"]).map(
  (value) => {
    if (!value.includes(":")) return { kind: "preset", preset: value };
    const [startDate, endDateInclusive] = value.split(":");
    return { kind: "custom", startDate, endDateInclusive };
  },
);

function convexRun(name, fnArgs, extra = []) {
  const output = execFileSync(
    "npx",
    ["convex", "run", ...deployment, "--typecheck", "disable", "--codegen", "disable", ...extra, name, JSON.stringify(fnArgs)],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  // The CLI prints the return value last; function logs, if any, come first.
  const start = output.search(/^[[{"]/m);
  return JSON.parse(start === -1 ? output : output.slice(start));
}

const EPSILON = 1e-6;
/** Paths where the two answers differ, at most `limit` of them. */
function differences(left, right, path = "", out = [], limit = 20) {
  if (out.length >= limit) return out;
  if (typeof left === "number" && typeof right === "number") {
    if (Math.abs(left - right) > EPSILON * Math.max(1, Math.abs(left))) out.push({ path, convex: left, clickhouse: right });
    return out;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) out.push({ path: `${path}.length`, convex: left.length, clickhouse: right.length });
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      differences(left[index], right[index], `${path}[${index}]`, out, limit);
    }
    return out;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      differences(left[key], right[key], path ? `${path}.${key}` : key, out, limit);
    }
    return out;
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) out.push({ path, convex: left, clickhouse: right });
  return out;
}

// Default only when there's exactly one tenant, so a run never checks the
// wrong one.
let tenantId = option("tenant")[0];
if (!tenantId) {
  const tenants = convexRun("analytics/parity:tenants", {});
  if (tenants.length !== 1) {
    console.error(`Pass --tenant <tenantId>. Tenants: ${tenants.map((tenant) => `${tenant.tenantId} (${tenant.companyName})`).join(", ") || "none"}`);
    process.exit(2);
  }
  tenantId = tenants[0].tenantId;
}
const identity = convexRun("analytics/parity:identity", { tenantId });
let failed = false;

for (const range of ranges) {
  const label = range.kind === "preset" ? range.preset : `${range.startDate}:${range.endDateInclusive}`;
  const plan = convexRun("analytics/parity:plan", {
    tenantId,
    page,
    range,
    timeZone,
    ...(filtersJson ? { filtersJson } : {}),
  });
  if (plan.length === 0) {
    console.error(`No reports on page ${page}.`);
    process.exit(2);
  }
  for (const item of plan) {
    const convexRaw = convexRun(item.liveName, JSON.parse(item.liveArgsJson), ["--identity", JSON.stringify(identity)]);
    // Internal readers (the API's) return their answer as JSON text.
    const convex = typeof convexRaw === "string" ? JSON.parse(convexRaw) : convexRaw;
    const payload = convexRun("analytics/parity:runNew", {
      tenantId,
      reportId: item.reportId,
      filtersJson: item.filtersJson,
      range: item.range,
    });
    const clickhouse = typeof payload === "string" ? JSON.parse(payload) : payload;
    const diff = differences(convex, clickhouse);
    if (diff.length === 0) {
      console.log(`ok    ${label}  ${item.reportId}`);
      continue;
    }
    failed = true;
    console.log(`DIFF  ${label}  ${item.reportId}`);
    for (const entry of diff) {
      console.log(`      ${entry.path || "(root)"}: convex=${JSON.stringify(entry.convex)} clickhouse=${JSON.stringify(entry.clickhouse)}`);
    }
  }
}
process.exit(failed ? 1 : 0);
