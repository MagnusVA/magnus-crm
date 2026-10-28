import { env } from "../_generated/server";

/**
 * Values travel as ClickHouse query parameters (`{name:Type}` in the SQL),
 * never pasted into the SQL text. Arrays are for `Array(String)` and
 * `Array(Int64)` parameters.
 */
export type SqlParamValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | readonly number[];

export type SqlQuery = {
  sql: string;
  params?: Record<string, SqlParamValue>;
};

export type SqlRow = Record<string, unknown>;

/** ClickHouse isn't set up on this deployment (dev never is). */
export class ClickHouseNotConfiguredError extends Error {
  constructor() {
    super("The reporting database isn't configured on this deployment.");
    this.name = "ClickHouseNotConfiguredError";
  }
}

export class ClickHouseQueryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ClickHouseQueryError";
  }
}

// A query on real data takes under a second; the rest covers waking the
// service from idle, which has taken over a minute.
const QUERY_TIMEOUT_MS = 150_000;
const WAKE_RETRY_DELAY_MS = 5_000;
const WAKE_RETRIES = 2;
// Code 202: magnus_app is already running its 4 queries. Runs go through a
// pool sized to that limit, so this is a rare overlap, such as a parity run
// during the batch. Each rejected query counts toward the login's hourly
// error quota, so the retries are few.
const BUSY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const ERROR_TEXT_LIMIT = 400;
const PARAM_NAME = /^[a-z_][a-z0-9_]*$/;

const ESCAPES: Record<string, string> = { "\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r", "\0": "\\0" };

/**
 * ClickHouse reads parameter values in its escaped text format, so a
 * backslash or a control character must be escaped to keep its meaning.
 */
function escapeText(value: string) {
  return value.replace(/[\\\t\n\r\0]/g, (char) => ESCAPES[char]);
}

function escapeArrayItem(value: string) {
  return `'${escapeText(value).replace(/'/g, "\\'")}'`;
}

/** The text form ClickHouse expects for a `param_<name>` value. */
export function formatSqlParam(value: SqlParamValue): string {
  if (value === null) return "\\N";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SQL parameters must be finite numbers.");
    return String(value);
  }
  if (typeof value === "string") return escapeText(value);
  return `[${value
    .map((item) => (typeof item === "string" ? escapeArrayItem(item) : String(item)))
    .join(",")}]`;
}

function clickHouseConfig() {
  const url = env.CLICKHOUSE_URL;
  const user = env.CLICKHOUSE_USER;
  const password = env.CLICKHOUSE_PASSWORD;
  if (!url || !user || !password) throw new ClickHouseNotConfiguredError();
  return { url, user, password };
}

export function isClickHouseConfigured() {
  return Boolean(env.CLICKHOUSE_URL && env.CLICKHOUSE_USER && env.CLICKHOUSE_PASSWORD);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(
  query: SqlQuery,
  settings: Record<string, string>,
): Promise<SqlRow[]> {
  const config = clickHouseConfig();
  const url = new URL(config.url);
  url.searchParams.set("default_format", "JSON");
  // Counts and sums arrive as numbers; every value we read fits in 2^53.
  url.searchParams.set("output_format_json_quote_64bit_integers", "0");
  for (const [name, value] of Object.entries(settings)) {
    url.searchParams.set(name, value);
  }
  for (const [name, value] of Object.entries(query.params ?? {})) {
    if (!PARAM_NAME.test(name)) throw new Error(`Invalid SQL parameter name ${name}.`);
    url.searchParams.set(`param_${name}`, formatSqlParam(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  try {
    let wakeRetries = 0;
    let busyRetries = 0;
    for (;;) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          body: query.sql,
          headers: {
            Authorization: `Basic ${btoa(`${config.user}:${config.password}`)}`,
            "Content-Type": "text/plain; charset=utf-8",
          },
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ClickHouseQueryError("The reporting database didn't answer in time.", null);
        }
        // A service waking from idle can drop the first connection.
        if (wakeRetries < WAKE_RETRIES) {
          wakeRetries += 1;
          await sleep(WAKE_RETRY_DELAY_MS);
          continue;
        }
        throw new ClickHouseQueryError(
          `The reporting database couldn't be reached: ${String(error).slice(0, ERROR_TEXT_LIMIT)}`,
          null,
        );
      }
      if (!response.ok) {
        const text = (await response.text()).slice(0, ERROR_TEXT_LIMIT);
        const busy =
          response.headers.get("X-ClickHouse-Exception-Code") === "202" ||
          text.includes("TOO_MANY_SIMULTANEOUS_QUERIES");
        // Busy first, so a busy 502 or 503 doesn't also use the wake retries.
        if (busy) {
          if (busyRetries < BUSY_RETRY_DELAYS_MS.length) {
            // Jittered, so runs that collided don't collide again.
            await sleep(BUSY_RETRY_DELAYS_MS[busyRetries] * (0.5 + Math.random()));
            busyRetries += 1;
            continue;
          }
        } else if ((response.status === 502 || response.status === 503) && wakeRetries < WAKE_RETRIES) {
          wakeRetries += 1;
          await sleep(WAKE_RETRY_DELAY_MS);
          continue;
        }
        throw new ClickHouseQueryError(text || `HTTP ${response.status}`, response.status);
      }
      const body = (await response.json()) as { data?: unknown };
      if (!Array.isArray(body.data)) {
        throw new ClickHouseQueryError("The reporting database returned no rows array.", response.status);
      }
      return body.data as SqlRow[];
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one report query for one tenant. The tenant is always the
 * `{tenant_id:String}` parameter, and also the `SQL_tenant_id` setting the
 * row policies read (§7.3).
 */
export async function queryTenantClickHouse(
  tenantId: string,
  query: SqlQuery,
): Promise<SqlRow[]> {
  if (query.params && "tenant_id" in query.params) {
    throw new Error("tenant_id is set by queryTenantClickHouse, not by the template.");
  }
  return await post(
    { sql: query.sql, params: { ...query.params, tenant_id: tenantId } },
    { SQL_tenant_id: tenantId },
  );
}

/**
 * Reads the newest heartbeat ClickHouse holds: the sync's watermark (§8.2).
 * Returns null before the first sync that copied `analyticsSync`.
 */
export async function queryWatermark(): Promise<number | null> {
  const rows = await post(
    { sql: "SELECT toUnixTimestamp64Milli(max(beat_at)) AS watermark, count() AS beats FROM analytics.watermark" },
    {},
  );
  const row = rows[0];
  if (!row || Number(row.beats) === 0) return null;
  const watermark = Number(row.watermark);
  return Number.isFinite(watermark) && watermark > 0 ? watermark : null;
}
