import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { httpAction, type ActionCtx } from "../../_generated/server";
import { isExpectedError } from "../../lib/observability/errors";
import { log, reportError } from "../../lib/observability/log";
import { sha256Hex } from "../../lib/webCrypto";
import { browserDay, type AnalyticsRange } from "../../../lib/analyticsRange";
import { validateBusinessDay } from "../../../lib/businessDay";
import { assertValidAnalyticsRange } from "../keys";
import { parseApiKey } from "./keys";
import { parseApiMetricsFilters, type ApiMetricsAnswer } from "./metrics";

// `/api/v1`: read-only metrics for outside dashboards
// (docs/plans/clickhouse-reporting.md §9, docs/api/openapi.yaml). Every
// route authenticates the key first, and the tenant always comes from it.

/** How long a request waits for an uncached range before answering 202. */
const WAIT_FOR_ANSWER_MS = 25_000;
const POLL_INTERVAL_MS = 1_500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Caller = { tenantId: Id<"tenants">; keyId: string };

/** The caller's mistake; its message is safe to return as a 400. */
class ApiRequestError extends Error {}

/** Runs a validator whose thrown message is safe, as an `ApiRequestError`. */
function validate(check: () => void) {
  try {
    check();
  } catch (error) {
    if (isExpectedError(error)) throw new ApiRequestError(error.data.message);
    throw new ApiRequestError(error instanceof Error ? error.message : "Invalid request.");
  }
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=300", ...headers },
  });
}

function fail(status: number, code: string, message: string, headers: Record<string, string> = {}) {
  return respond(status, { error: { code, message } }, { "Cache-Control": "no-store", ...headers });
}

function iso(ms: number | null) {
  return ms === null ? null : new Date(ms).toISOString();
}

async function authenticateCaller(ctx: ActionCtx, request: Request): Promise<Caller | Response> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  const parsed = match ? parseApiKey(match[1]) : null;
  if (!parsed) return fail(401, "unauthorized", "Send an API key as `Authorization: Bearer mgn_live_…`.");
  const result = await ctx.runMutation(internal.analytics.api.keys.authenticate, {
    keyId: parsed.keyId,
    secretHash: await sha256Hex(parsed.secret),
  });
  if (result.ok) return { tenantId: result.tenantId, keyId: result.keyId };
  if (result.status === 429) {
    return fail(429, "rate_limited", "A key may make 60 requests a minute.", {
      "Retry-After": String(result.retryAfterSeconds),
    });
  }
  return fail(401, "unauthorized", "The API key is missing, wrong or revoked.");
}

/** Wraps a route: authenticates, answers, and logs one `api.request` line. */
function route(handler: (ctx: ActionCtx, request: Request, caller: Caller) => Promise<Response>) {
  return httpAction(async (ctx, request) => {
    const path = new URL(request.url).pathname;
    const caller = await authenticateCaller(ctx, request);
    if (caller instanceof Response) {
      log.info("api.request", { path, status: caller.status });
      return caller;
    }
    let response: Response;
    try {
      response = await handler(ctx, request, caller);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        response = fail(400, "invalid_request", error.message);
      } else {
        // Server failures stay retryable and never show internal text.
        reportError("api.request_failed", error, { path, tenantId: caller.tenantId, keyId: caller.keyId });
        response = fail(500, "internal_error", "Something went wrong. Try again shortly.");
      }
    }
    log.info("api.request", { path, status: response.status, tenantId: caller.tenantId, keyId: caller.keyId });
    return response;
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Answers a metrics request from the cache, starting a run when nothing
 * current answers it and waiting up to 25 s for it; past that, 202.
 */
async function warehouseMetrics(
  ctx: ActionCtx,
  caller: Caller,
  args: { metrics: string; granularity: string; groupBy: string; range: AnalyticsRange; timeZone?: string },
): Promise<{ response: Response } | { answer: ApiMetricsAnswer; meta: Record<string, unknown> }> {
  validate(() => {
    parseApiMetricsFilters({ metrics: args.metrics, granularity: args.granularity, group_by: args.groupBy });
    assertValidAnalyticsRange(args.range);
    if (args.timeZone) validateBusinessDay(browserDay(args.timeZone));
  });

  const { argsKey } = await ctx.runMutation(internal.analytics.api.queries.requestMetrics, {
    tenantId: caller.tenantId,
    metrics: args.metrics,
    granularity: args.granularity,
    groupBy: args.groupBy,
    range: args.range,
    ...(args.timeZone ? { timeZone: args.timeZone } : {}),
  });
  const deadline = Date.now() + WAIT_FOR_ANSWER_MS;
  for (;;) {
    const state = await ctx.runQuery(internal.analytics.api.queries.metricsAnswer, {
      tenantId: caller.tenantId,
      argsKey,
    });
    const freshness = await ctx.runQuery(internal.analytics.api.queries.freshness, {});
    const meta = {
      as_of: iso(state.watermark),
      source: "warehouse",
      next_expected_refresh: iso(freshness.nextExpectedRefresh),
    };
    if (state.state === "ready" && state.payloadJson) {
      return { answer: JSON.parse(state.payloadJson) as ApiMetricsAnswer, meta };
    }
    if (state.state === "failed" || state.state === "queued") {
      if (state.payloadJson) {
        return { answer: JSON.parse(state.payloadJson) as ApiMetricsAnswer, meta: { ...meta, stale: true } };
      }
      const retryAfter = freshness.nextExpectedRefresh
        ? Math.max(60, Math.ceil((freshness.nextExpectedRefresh - Date.now()) / 1000))
        : 3600;
      return {
        response:
          state.state === "queued"
            ? respond(202, { status: "queued", message: "This range is computed after the next refresh." }, { "Retry-After": String(retryAfter), "Cache-Control": "no-store" })
            : fail(503, "warehouse_unavailable", state.errorMessage ?? "The reporting database couldn't answer.", { "Retry-After": "300" }),
      };
    }
    if (Date.now() >= deadline) {
      return {
        response: respond(202, { status: "pending", message: "This range is being computed. Try again shortly." }, { "Retry-After": "30", "Cache-Control": "no-store" }),
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function rangeFrom(params: URLSearchParams): AnalyticsRange {
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (!DATE.test(from) || !DATE.test(to)) throw new ApiRequestError("Send `from` and `to` as YYYY-MM-DD.");
  return { kind: "custom", startDate: from, endDateInclusive: to };
}

/** `GET /api/v1/metrics`: any range, from the reporting database as of the last sync. */
export const apiMetrics = route(async (ctx, request, caller) => {
  const params = new URL(request.url).searchParams;
  const result = await warehouseMetrics(ctx, caller, {
    metrics: params.get("metrics") ?? "",
    granularity: params.get("granularity") ?? "day",
    groupBy: params.get("group_by") ?? "none",
    range: rangeFrom(params),
    timeZone: params.get("tz") ?? undefined,
  });
  if ("response" in result) return result.response;
  return respond(200, { data: result.answer.rows, meta: result.meta });
});

const FUNNEL_STEPS = {
  captured: "leads_captured",
  qualified: "qualifications",
  booked: "calls_booked",
  held: "calls_held",
  won: "deals_won",
} as const;

/** `GET /api/v1/funnel`: captured, qualified, booked, held and won for a range. */
export const apiFunnel = route(async (ctx, request, caller) => {
  const params = new URL(request.url).searchParams;
  const result = await warehouseMetrics(ctx, caller, {
    metrics: Object.values(FUNNEL_STEPS).join(","),
    granularity: "total",
    groupBy: "none",
    range: rangeFrom(params),
    timeZone: params.get("tz") ?? undefined,
  });
  if ("response" in result) return result.response;
  const value = (metric: string) => result.answer.rows.find((row) => row.metric === metric)?.value ?? 0;
  const data = Object.fromEntries(Object.entries(FUNNEL_STEPS).map(([step, metric]) => [step, value(metric)]));
  return respond(200, { data, meta: result.meta });
});

/** `GET /api/v1/today`: today's metrics, read live. */
export const apiToday = route(async (ctx, request, caller) => {
  const params = new URL(request.url).searchParams;
  const metrics = params.get("metrics") ?? "";
  const groupBy = params.get("group_by") ?? "none";
  const timeZone = params.get("tz");
  validate(() => {
    parseApiMetricsFilters({ metrics, granularity: "day", group_by: groupBy });
    if (timeZone) validateBusinessDay(browserDay(timeZone));
  });
  const today = await ctx.runQuery(internal.analytics.api.queries.todayMetrics, {
    tenantId: caller.tenantId,
    metrics,
    granularity: "day",
    groupBy,
    ...(timeZone ? { timeZone } : {}),
  });
  const answer = JSON.parse(today.answerJson) as ApiMetricsAnswer;
  return respond(
    200,
    { data: answer.rows, meta: { source: "live", date: today.date, partial: answer.partial } },
    { "Cache-Control": "private, max-age=60" },
  );
});

const DIMENSION_KINDS = ["team-members", "teams", "programs"] as const;

/** `GET /api/v1/dimensions/{team-members|teams|programs}`: ids and names for `group_by`. */
export const apiDimensions = route(async (ctx, request, caller) => {
  const kind = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  if (!(DIMENSION_KINDS as readonly string[]).includes(kind)) {
    return fail(404, "not_found", "Dimensions are team-members, teams and programs.");
  }
  const rows = await ctx.runQuery(internal.analytics.api.queries.dimensions, {
    tenantId: caller.tenantId,
    kind: kind as (typeof DIMENSION_KINDS)[number],
  });
  return respond(200, { data: rows });
});

/** `GET /api/v1/freshness`: when the reporting data was last refreshed. */
export const apiFreshness = route(async (ctx) => {
  const freshness = await ctx.runQuery(internal.analytics.api.queries.freshness, {});
  return respond(
    200,
    {
      data: {
        as_of: iso(freshness.asOf),
        last_sync_ended_at: iso(freshness.lastSyncEndedAt),
        next_expected_refresh: iso(freshness.nextExpectedRefresh),
      },
    },
    { "Cache-Control": "private, max-age=60" },
  );
});
