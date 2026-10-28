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
// overview, my_activity, and api for the external API's metrics. With no
// --range it checks yesterday, last_month and last_90_days. Exits 1 when any
// report differs.
//
// The Convex CLI ignores --prod when CONVEX_DEPLOY_KEY is set, in the shell or
// in .env.local, and runs against the key's deployment. Export the production
// deploy key first if .env.local holds a dev one; the script stops otherwise.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
const dev = args.includes("--dev");
const deployment = dev ? [] : ["--prod"];

/** The deploy key the CLI will use, and where it came from, or null. */
function deployKey() {
  // An exported value wins over the files, even an empty one.
  if (process.env.CONVEX_DEPLOY_KEY !== undefined) {
    return process.env.CONVEX_DEPLOY_KEY ? { key: process.env.CONVEX_DEPLOY_KEY, source: "the shell" } : null;
  }
  for (const file of [".env.local", ".env"]) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const line = text.split("\n").find((entry) => entry.startsWith("CONVEX_DEPLOY_KEY="));
    const key = line?.slice("CONVEX_DEPLOY_KEY=".length).trim().replace(/^["']|["']$/g, "");
    if (key) return { key, source: file };
  }
  return null;
}
// Only a key whose prefix names the requested deployment type passes.
const found = deployKey();
if (found && !found.key.startsWith(dev ? "dev:" : "prod:")) {
  // Name the deployment only from a `type:name|secret` key, never print the rest.
  const target = /^[a-z]+:[a-z0-9-]+(?=\|)/.exec(found.key)?.[0];
  console.error(
    `CONVEX_DEPLOY_KEY from ${found.source} ${target ? `is for ${target}` : "isn't a deploy key the script recognizes"}, ` +
      `and the Convex CLI uses it instead of ${dev ? "the dev deployment" : "--prod"}. ` +
      `Export the ${dev ? "dev" : "production"} deploy key in this shell and run it again.`,
  );
  process.exit(2);
}
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

/** The useful line of a failed CLI call: the server's error, or the last line. */
function errorLine(error) {
  const lines = String(error.stderr ?? error.message)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => line.startsWith("Uncaught ")) ?? lines.at(-1);
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

// The form_answers view shows contact answers as this text (clickhouse/
// migrations/0002_views.sql), so Leads' top answers and distributions differ
// there by design. Those differences are reported as masked, not failures;
// every response count must still match.
const MASKED_ANSWER = "Hidden contact detail";

function valueAt(root, path) {
  let value = root;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

/**
 * A field's top answer, its count and its share, when masking changed them:
 * ClickHouse shows the mask and Convex's top answer is something else. A
 * field whose real top answer is the literal mask text is compared in full,
 * so the rule errs toward failing.
 */
function isMaskedDifference(convex, clickhouse, path) {
  const field = path.match(/^(topAnswerPerField\[\d+\])\.(topAnswer|topAnswerCount|topAnswerShare)$/);
  return (
    field !== null &&
    valueAt(clickhouse, `${field[1]}.topAnswer`) === MASKED_ANSWER &&
    valueAt(convex, `${field[1]}.topAnswer`) !== MASKED_ANSWER
  );
}

/**
 * An answer distribution, compared by answer: every answer ClickHouse shows
 * must have Convex's count, and the answers it hid must add up to its
 * `Hidden contact detail` count. An answer that changed or went missing for
 * another reason still fails.
 */
function distributionDifferences(convex, clickhouse) {
  const out = [];
  const left = new Map((convex?.distribution ?? []).map((entry) => [entry.answer, entry.count]));
  const right = new Map((clickhouse?.distribution ?? []).map((entry) => [entry.answer, entry.count]));
  const maskedCount = right.get(MASKED_ANSWER) ?? 0;
  let hiddenCount = 0;
  let hiddenAnswers = 0;
  for (const [answer, count] of left) {
    // ClickHouse folds a literal answer of the mask text into its bucket.
    if (answer === MASKED_ANSWER || !right.has(answer)) {
      hiddenCount += count;
      hiddenAnswers += 1;
    } else if (right.get(answer) !== count) {
      out.push({ path: `distribution[${JSON.stringify(answer)}]`, convex: count, clickhouse: right.get(answer) });
    }
  }
  for (const [answer, count] of right) {
    if (answer !== MASKED_ANSWER && !left.has(answer)) {
      out.push({ path: `distribution[${JSON.stringify(answer)}]`, convex: undefined, clickhouse: count });
    }
  }
  if (hiddenCount !== maskedCount) {
    out.push({ path: `distribution[${JSON.stringify(MASKED_ANSWER)}]`, convex: hiddenCount, clickhouse: maskedCount });
  }
  const expectedDistinct = (convex?.distinctAnswers ?? left.size) - hiddenAnswers + (maskedCount > 0 ? 1 : 0);
  if (clickhouse?.distinctAnswers !== expectedDistinct) {
    out.push({ path: "distinctAnswers", convex: expectedDistinct, clickhouse: clickhouse?.distinctAnswers });
  }
  return out;
}

function withoutKeys(value, keys) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
}

/** Every difference, masked ones excluded; the caller limits what it prints. */
function reportDifferences(convex, clickhouse) {
  if (Array.isArray(clickhouse?.distribution)) {
    const keys = ["distribution", "distinctAnswers"];
    return [
      ...distributionDifferences(convex, clickhouse),
      ...differences(withoutKeys(convex, keys), withoutKeys(clickhouse, keys), "", [], Number.POSITIVE_INFINITY),
    ];
  }
  return differences(convex, clickhouse, "", [], Number.POSITIVE_INFINITY);
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
    if (item.error) {
      // A filter the report needs and has no default for (Leads' fieldKey).
      failed = true;
      console.log(`ERROR ${label}  ${item.reportId}: ${item.error} Pass its filters with --filters.`);
      continue;
    }
    let convexRaw;
    try {
      convexRaw = convexRun(item.liveName, JSON.parse(item.liveArgsJson), ["--identity", JSON.stringify(identity)]);
    } catch (error) {
      // Production hides a public function's error; its request ID finds it
      // in `npx convex logs --prod`.
      failed = true;
      console.log(`ERROR ${label}  ${item.reportId} (Convex reader): ${errorLine(error)}`);
      continue;
    }
    // Internal readers (the API's) return their answer as JSON text.
    const convex = typeof convexRaw === "string" ? JSON.parse(convexRaw) : convexRaw;
    let payload;
    try {
      payload = convexRun("analytics/parity:runNew", {
        tenantId,
        reportId: item.reportId,
        filtersJson: item.filtersJson,
        range: item.range,
      });
    } catch (error) {
      failed = true;
      console.log(`ERROR ${label}  ${item.reportId} (ClickHouse): ${errorLine(error)}`);
      continue;
    }
    const clickhouse = typeof payload === "string" ? JSON.parse(payload) : payload;
    const all = reportDifferences(convex, clickhouse);
    const masked = all.filter((entry) => isMaskedDifference(convex, clickhouse, entry.path));
    const unmasked = all.filter((entry) => !isMaskedDifference(convex, clickhouse, entry.path));
    const diff = unmasked.slice(0, 20);
    if (diff.length === 0) {
      console.log(`ok    ${label}  ${item.reportId}${masked.length ? `  (${masked.length} masked contact answers)` : ""}`);
      continue;
    }
    failed = true;
    console.log(`DIFF  ${label}  ${item.reportId}`);
    if (unmasked.length > diff.length) console.log(`      (${unmasked.length - diff.length} more)`);
    for (const entry of diff) {
      console.log(`      ${entry.path || "(root)"}: convex=${JSON.stringify(entry.convex)} clickhouse=${JSON.stringify(entry.clickhouse)}`);
    }
  }
}
process.exit(failed ? 1 : 0);
