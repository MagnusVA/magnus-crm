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
// Pages: scorecard, calls, people, attribution, revenue, sales_calls,
// booked_calls, qualifications, lead_gen, overview, my_activity, and api for
// the external API's metrics. With no --range it checks yesterday, last_month
// and last_90_days. Any mismatch, SKIP or missing required comparison exits 1.
// Repeat --filters for a required member-filter matrix. --coverage <file>
// instead reads [{reportId, range, filters}], with string ranges as above.
// Compare definitions with --active <id> --candidate <id>. The local hourly
// budget defaults to --max-queries 150 --max-seconds 300; --budget-file may
// select a shared ledger. One process at a time holds its lock.
//
// The Convex CLI ignores --prod when CONVEX_DEPLOY_KEY is set, in the shell or
// in .env.local, and runs against the key's deployment. Export the production
// deploy key first if .env.local holds a dev one; the script stops otherwise.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cappedBy, canonical, coverageKey, coverageFailures, reportDifferences, isMaskedDifference } from "./analytics-parity-core.mjs";
import { parse as parseDotenv } from "dotenv";

export function main(argv = process.argv.slice(2), injectedRun) {
  const args = argv;
  const page = args.find((arg) => !arg.startsWith("--"));
  if (!page) {
    console.error("Usage: pnpm analytics:parity <page> [--range …] [--tz …] [--tenant …] [--filters …] [--dev]");
    return 2;
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
      // With dotenv 16, the parser the Convex CLI bundles: `export`, quotes,
      // comments, and the last line wins. Node's parseEnv differs (a blank value
      // can swallow the next line). The first file that sets the key wins, even
      // empty.
      const values = parseDotenv(text);
      if (Object.hasOwn(values, "CONVEX_DEPLOY_KEY")) {
        return values.CONVEX_DEPLOY_KEY ? { key: values.CONVEX_DEPLOY_KEY, source: file } : null;
      }
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
    return 2;
  }
  const timeZone = option("tz")[0] ?? "America/Tegucigalpa";
  const candidateId = option("candidate")[0];
  const activeId = option("active")[0];
  if (Boolean(candidateId) !== Boolean(activeId)) {
    console.error("Compare mode needs both --candidate <id> and --active <id>.");
    return 2;
  }
  function parseRange(value) {
    if (typeof value !== "string") return value;
    if (!value.includes(":")) return { kind: "preset", preset: value };
    const [startDate, endDateInclusive] = value.split(":");
    return { kind: "custom", startDate, endDateInclusive };
  }
  const ranges = (option("range").length ? option("range") : ["yesterday", "last_month", "last_90_days"]).map(parseRange);
  let filterSets;
  try {
    filterSets = (option("filters").length ? option("filters") : ["{}"]).map(value => JSON.parse(value));
    if (args.includes("--filters") && !option("filters").length ||
      filterSets.some(value => !value || typeof value !== "object" || Array.isArray(value))) throw new Error();
  } catch {
    console.error('--filters must be a JSON object. Repeat it to require several member filters.');
    return 2;
  }
  const maxQueries = Number(option("max-queries")[0] ?? 150);
  const maxSeconds = Number(option("max-seconds")[0] ?? 300);
  if (!Number.isSafeInteger(maxQueries) || maxQueries < 1 || !Number.isFinite(maxSeconds) || maxSeconds < 30) {
    console.error("Budgets require a positive integer --max-queries and --max-seconds >= 30.");
    return 2;
  }

  function convexRun(name, fnArgs, extra = []) {
    if (injectedRun) return injectedRun(name, fnArgs, extra);
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

  let ledger;
  const observed = [];
  let required = [];
  let failed = false;
  let totals = { queries: 0, seconds: 0, retries: 0, builds: 0, discarded: 0, repeated: 0 };
  try {
    // One local process holds this lock for the entire run, including retries.
    ledger = openBudget(option("budget-file")[0], maxQueries, maxSeconds);
    let tenantId = option("tenant")[0];
    if (!tenantId) {
      const tenants = convexRun("analytics/parity:tenants", {});
      if (tenants.length !== 1) throw new Error("Pass --tenant <tenantId>; the deployment does not have exactly one tenant.");
      tenantId = tenants[0].tenantId;
    }
    const panels = activeId ? [activeId] : convexRun("analytics/parity:requiredReports", { page });
    const coverageFile = option("coverage")[0];
    required = coverageFile ? JSON.parse(readFileSync(coverageFile, "utf8")).map(item => ({
      reportId: item.reportId, range: parseRange(item.range), filters: item.filters ?? {},
    })) : panels.flatMap(reportId => ranges.flatMap(range => filterSets.map(filters => ({ reportId, range, filters }))));
    if (!required.length || required.some(item => typeof item.reportId !== "string" ||
      !item.range || !["preset", "custom"].includes(item.range.kind) || !item.filters ||
      typeof item.filters !== "object" || Array.isArray(item.filters))) {
      throw new Error("incomplete verification: required coverage must list panels, ranges and filter objects");
    }
    if (new Set(required.map(coverageKey)).size !== required.length) throw new Error("Duplicate required coverage tuples.");
    console.log(`Required coverage: ${required.length} comparisons`);
    for (const item of required) console.log(`REQUIRE ${coverageKey(item)}`);
    const identity = candidateId ? null : convexRun("analytics/parity:identity", { tenantId });
    let printedLimitation = false;
    for (const requirement of required) {
      const label = coverageKey(requirement);
      const record = status => observed.push({ ...requirement, status });
      let plan;
      try {
        plan = convexRun("analytics/parity:plan", {
          tenantId, page, range: requirement.range, timeZone, filtersJson: JSON.stringify(requirement.filters),
          ...(candidateId ? { reportIds: [requirement.reportId, candidateId] } : {}),
        });
      } catch (error) {
        record("plan error");
        console.log(`ERROR ${label}: ${errorLine(error)}`);
        continue;
      }
      const matches = plan.filter(item => item.reportId === requirement.reportId);
      const item = matches[0];
      if (matches.length !== 1 || !item || item.error) {
        record(matches.length !== 1 ? "missing or duplicate panel" : "filter error");
        console.log(`ERROR ${label}: ${item?.error ?? "missing or duplicate required panel"}`);
        continue;
      }
      if (candidateId) {
        const candidates = plan.filter(entry => entry.reportId === candidateId);
        const candidate = candidates[0];
        if (candidates.length !== 1 || candidate.error || candidate.filtersJson !== item.filtersJson ||
          JSON.stringify(canonical(candidate.range)) !== JSON.stringify(canonical(item.range))) {
          record("candidate inputs differ or are missing");
          console.log(`ERROR ${label}: candidate and active need identical parsed filters and range`);
          continue;
        }
      }
      let reference;
      if (!candidateId) {
        try {
          const raw = convexRun(item.liveName, JSON.parse(item.liveArgsJson), ["--identity", JSON.stringify(identity)]);
          reference = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (error) {
          record("SKIP: reader error or range cap");
          console.log(`SKIP ${label}: ${errorLine(error)}`);
          continue;
        }
        const cap = cappedBy(reference);
        if (cap) {
          record(`SKIP: capped reference (${cap})`);
          console.log(`SKIP ${label}: capped reference (${cap})`);
          continue;
        }
      }
      const allowance = ledger.remaining();
      if (allowance.maxQueries < 1 || allowance.maxSeconds < 30) {
        record("budget exceeded");
        console.log(`STOP ${label}: incomplete verification: hourly ClickHouse budget would be exceeded`);
        break;
      }
      let result;
      try {
        const raw = convexRun("analytics/parity:runBudgeted", {
          tenantId, reportId: item.reportId, ...(candidateId ? { candidateId } : {}),
          filtersJson: item.filtersJson, range: item.range, ...allowance,
        });
        result = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!Array.isArray(result.usage?.attempts) || result.usage.attempts.some(attempt =>
          !Number.isFinite(attempt.at) || !Number.isFinite(attempt.seconds) || attempt.seconds < 0)) {
          throw new Error("missing or invalid query accounting");
        }
        ledger.record(result.usage.attempts.map(attempt => ({ at: attempt.at, queries: 1, seconds: attempt.seconds })));
        for (const key of Object.keys(totals)) totals[key] += result.usage[key] ?? 0;
      } catch (error) {
        // A lost action response cannot prove what ran. Reserve its whole
        // allowance for the next hour instead of silently losing those queries.
        ledger.record([{ at: Date.now(), queries: allowance.maxQueries, seconds: allowance.maxSeconds }]);
        totals.queries += allowance.maxQueries;
        totals.seconds += allowance.maxSeconds;
        record("warehouse action or accounting error");
        console.log(`STOP ${label}: incomplete verification: ${errorLine(error)}`);
        break;
      }
      if (!printedLimitation) {
        console.log(`Limitation: ${result.limitation}`);
        printedLimitation = true;
      }
      if (result.status !== "complete") {
        record("incomplete verification");
        console.log(`STOP ${label}: incomplete verification: ${result.error}`);
        break;
      }
      const all = candidateId ? result.differences : reportDifferences(reference, result.active);
      const diff = candidateId ? all : all.filter(entry => !isMaskedDifference(reference, result.active, entry.path));
      const cap = cappedBy(result.active) || cappedBy(result.candidate);
      if (cap) {
        record(`SKIP: capped warehouse (${cap})`);
        continue;
      }
      record(diff.length ? "DIFF" : "ok");
      console.log(`${diff.length ? "DIFF" : "ok"} ${label}`);
      for (const entry of diff.slice(0, 20)) console.log(
        `  ${entry.path || "(root)"}: reference=${JSON.stringify(entry.convex)} candidate=${JSON.stringify(entry.clickhouse)}`,
      );
      if (diff.length > 20) console.log(`  ${diff.length - 20} more differences`);
      else if (candidateId && result.differenceCount > diff.length) console.log(`  ${result.differenceCount - diff.length} more differences`);
    }
    const incomplete = coverageFailures(required, observed);
    failed = incomplete.length > 0;
    for (const item of incomplete) console.log(`FAIL ${coverageKey(item)}: ${item.reason}`);
    if (incomplete.some(item => item.reason !== "DIFF")) console.error("incomplete verification: every required panel × range × filter comparison must pass");
    else if (failed) console.error("Parity failed: required comparisons differ.");
  } catch (error) {
    failed = true;
    console.error(`incomplete verification: ${errorLine(error)}`);
  } finally {
    ledger?.close();
  }
  console.log(`Query usage: ${JSON.stringify(totals)}`);
  return failed ? 1 : 0;
}

/** Rolling local hourly ledger, shared by ordinary and candidate runs. */
function openBudget(file, maxQueries, maxSeconds) {
  const path = file ? resolve(file) : join(tmpdir(), `magnus-analytics-parity-${process.getuid?.() ?? "user"}.json`);
  const lock = `${path}.lock`;
  let fd;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw new Error(`incomplete verification: another parity process holds ${lock}. Remove a stale lock only after checking its pid.`);
  }
  try {
    writeFileSync(fd, String(process.pid));
    let events;
    try {
      events = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(events) || events.some(event => !Number.isFinite(event.at) ||
        !Number.isSafeInteger(event.queries) || event.queries < 0 || !Number.isFinite(event.seconds) || event.seconds < 0)) {
        throw new Error("Invalid budget ledger");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      events = [];
    }
    const prune = () => { events = events.filter(event => event.at > Date.now() - 3_600_000); };
    return {
      remaining() {
        prune();
        return { maxQueries: Math.max(0, maxQueries - events.reduce((n, event) => n + event.queries, 0)),
          maxSeconds: Math.max(0, maxSeconds - events.reduce((n, event) => n + event.seconds, 0)) };
      },
      record(next) {
        prune();
        events.push(...next);
        writeFileSync(path, JSON.stringify(events), { mode: 0o600 });
      },
      close() { closeSync(fd); unlinkSync(lock); },
    };
  } catch (error) {
    closeSync(fd);
    unlinkSync(lock);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
