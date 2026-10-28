#!/usr/bin/env node
// Applies clickhouse/migrations/*.sql in order and records each in
// analytics._migrations (docs/plans/clickhouse-reporting.md §7.1).
//
//   CLICKHOUSE_ADMIN_URL=https://<host>:8443 CLICKHOUSE_ADMIN_USER=default \
//   CLICKHOUSE_ADMIN_PASSWORD=… pnpm ch:migrate [--dry-run] [--only 0003_watermark]
//
// There is one ClickHouse service and it holds production data, so run this
// right after a Fivetran sync, while the service is awake (§12.1). Views are
// CREATE OR REPLACE, so applying a file again is safe.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, "clickhouse", "migrations");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex === -1 ? null : args[onlyIndex + 1];

const url = process.env.CLICKHOUSE_ADMIN_URL;
const user = process.env.CLICKHOUSE_ADMIN_USER ?? "default";
const password = process.env.CLICKHOUSE_ADMIN_PASSWORD;
if (!dryRun && (!url || !password)) {
  console.error(
    "Set CLICKHOUSE_ADMIN_URL and CLICKHOUSE_ADMIN_PASSWORD (and CLICKHOUSE_ADMIN_USER if it isn't default).",
  );
  process.exit(1);
}

async function run(sql) {
  const response = await fetch(url, {
    method: "POST",
    body: sql,
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 800));
  return text;
}

/**
 * Drops comment lines, then splits on statement-ending semicolons, so a
 * comment that ends in `;` can't split a statement.
 */
export function statements(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
let applied = new Set();
if (!dryRun) {
  try {
    const text = await run("SELECT name FROM analytics._migrations FORMAT TabSeparated");
    applied = new Set(text.split("\n").filter(Boolean));
  } catch {
    // No analytics database yet: 0001 creates it.
  }
}

for (const file of files) {
  const name = file.replace(/\.sql$/, "");
  if (only && name !== only) continue;
  if (!only && applied.has(name)) {
    console.log(`skip  ${name}`);
    continue;
  }
  const parts = statements(await readFile(path.join(dir, file), "utf8"));
  if (dryRun) {
    console.log(`would apply ${name}: ${parts.length} statements`);
    continue;
  }
  for (const statement of parts) await run(statement);
  await run(`INSERT INTO analytics._migrations (name) VALUES ('${name.replace(/'/g, "")}')`);
  console.log(`apply ${name}: ${parts.length} statements`);
}
