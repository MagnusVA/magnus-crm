#!/usr/bin/env node
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { measure } from "./whop-measure/aggregate.mjs";
import { buildCrm, OPTIONAL_TABLES, REQUIRED_TABLES } from "./whop-measure/crm.mjs";
import { DAY } from "./whop-measure/normalize.mjs";
import { replayScan, scanPayments, whopPageReader } from "./whop-measure/paging.mjs";
import { renderReport } from "./whop-measure/report.mjs";

const USAGE = `Usage: node scripts/whop-measure.mjs --account biz_… --crm <export-folder>
  [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--sandbox] [--dry-run <fixtures.json>]
  [--out <file.md>] [--sample-out <file.local.json>] [--allow-repo-output]

Dates are UTC. --to is exclusive and defaults to today. --from defaults to
90 days before --to. Without --dry-run, set WHOP_API_KEY in the environment.
Outputs default to whop-measurement.md and whop-measurement-sample.local.json
in the current directory. Use new files outside a Git checkout.`;

const OPTIONS = {
  account: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  crm: { type: "string" },
  out: { type: "string" },
  "sample-out": { type: "string" },
  sandbox: { type: "boolean" },
  "dry-run": { type: "string" },
  "allow-repo-output": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

function options() {
  try {
    return parseArgs({ options: OPTIONS }).values;
  } catch {
    throw new Error("Invalid arguments. Run with --help for usage.");
  }
}

function utcDate(value, flag) {
  const time = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new Error(`The ${flag} date must be a valid YYYY-MM-DD date.`);
  }
  return time;
}

function measurementWindow({ from, to }) {
  const end = to === undefined ? Math.floor(Date.now() / DAY) * DAY : utcDate(to, "--to");
  const start = from === undefined ? end - 90 * DAY : utcDate(from, "--from");
  if (start >= end) throw new Error("--from must be earlier than --to.");
  return { from: start, to: end };
}

function readCrm(folder) {
  const paths = new Map([...REQUIRED_TABLES, ...OPTIONAL_TABLES].map((name) =>
    [name, join(folder, name, "documents.jsonl")]));
  const missing = REQUIRED_TABLES.filter((name) => !existsSync(paths.get(name)));
  if (missing.length) {
    throw new Error(`Missing CRM tables under --crm: ${missing.join(", ")}. Each needs documents.jsonl.`);
  }
  const tables = {};
  for (const [name, path] of paths) {
    let contents;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT" && OPTIONAL_TABLES.includes(name)) continue;
      throw new Error(`Unable to read CRM table ${name}.`);
    }
    const rows = [];
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error();
        rows.push(row);
      } catch {
        throw new Error(`Invalid CRM row in ${name} at line ${index + 1}.`);
      }
    }
    tables[name] = rows;
  }
  return tables;
}

function readFixtures(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Unable to read --dry-run fixtures as JSON.");
  }
}

function inCheckout(directory) {
  let current = directory;
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function outputPath(path, flag, allowRepo) {
  if (!path) throw new Error(`Supply a file for ${flag}.`);
  const absolutePath = resolve(path);
  let directory;
  try {
    directory = realpathSync(dirname(absolutePath));
  } catch {
    throw new Error(`The output directory for ${flag} does not exist or cannot be read.`);
  }
  if (!allowRepo && inCheckout(directory)) {
    throw new Error(`Refusing ${flag} inside a Git checkout. Run outside the repository or pass --allow-repo-output.`);
  }
  const destination = join(directory, basename(absolutePath));
  if (lstatSync(destination, { throwIfNoEntry: false })) {
    throw new Error(`The file for ${flag} already exists. Choose a new output path.`);
  }
  return destination;
}

function writeOutputs(reportPath, samplePath, report, sample) {
  const created = [];
  try {
    for (const [path, contents] of [
      [samplePath, `${JSON.stringify(sample, null, 2)}\n`], [reportPath, report],
    ]) {
      // Open exclusively to avoid overwriting existing reports or following a symlink.
      const file = openSync(path, "wx", 0o600);
      created.push(path);
      try {
        writeFileSync(file, contents);
      } finally {
        closeSync(file);
      }
    }
  } catch {
    for (const path of created) {
      try {
        unlinkSync(path);
      } catch {
        // Keep the underlying write error and report where to check.
      }
    }
    throw new Error("Could not write both outputs. Check both paths for partial files and choose new output paths.");
  }
}

async function main() {
  const values = options();
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const fixturePath = values["dry-run"];
  const apiKey = fixturePath ? undefined : process.env.WHOP_API_KEY?.trim();
  if (!fixturePath && !apiKey) throw new Error("Set WHOP_API_KEY in the environment or supply --dry-run.");
  const account = values.account;
  if (!/^biz_[a-zA-Z0-9]{4,196}$/.test(account ?? "")) throw new Error("--account must be a Whop account ID beginning with biz_.");
  if (!values.crm) throw new Error("Supply --crm with an extracted CRM export folder.");

  const window = measurementWindow(values);
  const allowRepo = values["allow-repo-output"];
  const reportPath = outputPath(values.out ?? "whop-measurement.md", "--out", allowRepo);
  const samplePath = outputPath(values["sample-out"] ?? "whop-measurement-sample.local.json", "--sample-out", allowRepo);
  if (reportPath === samplePath) throw new Error("--out and --sample-out must point to different files.");

  const sandbox = values.sandbox ?? false;
  const crm = buildCrm(readCrm(values.crm), { account, sandbox });
  const fixtures = fixturePath ? readFixtures(fixturePath) : undefined;
  const readPage = fixturePath ? undefined : whopPageReader({ apiKey, sandbox });
  const times = {};
  const scans = {};
  for (const [name, filter] of [["first", "created"], ["second", "created"],
    ["refunds", "refunded"], ["disputes", "dispute_created"]]) {
    const started = Date.now();
    const scan = { account, window, filter };
    scans[name] = fixturePath ? await replayScan(fixtures?.[name], scan) : await scanPayments(readPage, scan);
    times[name] = { started, finished: Date.now() };
  }

  const { report, sample } = measure({ crm, scans, window, asOf: times.second.started });
  const markdown = renderReport(report, { account, window, times, sandbox, dryRun: Boolean(fixturePath) });
  writeOutputs(reportPath, samplePath, markdown, sample);
  console.log(`Wrote the aggregate report to ${reportPath}`);
  console.warn(`Warning: the hand-check sample at ${samplePath} contains personal data. Do not commit or share it.`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
