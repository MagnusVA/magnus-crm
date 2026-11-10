"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import type { ResolvedAnalyticsRange } from "../../lib/analyticsRange";
import { log, reportError } from "../lib/observability/log";
import {
  ClickHouseNotConfiguredError,
  RowsBudgetExceededError,
  queryTenantClickHouse,
  type RowsBudget,
  type SqlRow,
} from "./clickhouse";
import type { AnalyticsFilters } from "./definition";
import { getReportDefinition } from "./registry";
import { ANSWER_TOO_LARGE, MAX_ANSWER_BYTES, answerBytes, resolvedRangeValidator, splitPayload } from "./results";
import { storeAnswerParts } from "../mcp/reports/payloads";

// The Node build path (docs/agents/reporting.md): reports whose rows are too
// large to pass into the `complete` mutation, or whose build needs more than
// a mutation's CPU, build here. The rows never leave this action; only the
// answer, split into parts, goes to `complete`. Node actions have 512 MiB.

/**
 * Characters of ClickHouse response text one report may read. Measured on
 * production rows in November 2026: the largest year was 7.1M (People's
 * closers), 14.1M with the data doubled, and memory grew about 11 bytes per
 * character, so 16M keeps a run near half of Node's 512 MiB.
 */
export const MAX_NODE_ROWS_CHARS = 16_000_000;

const FAILED = "The reporting database couldn't answer this range. It tries again after the next refresh.";
/**
 * Pause between stored parts. One part per transaction, about 4 MB a second
 * at most, keeps a 12 MB answer from spending the deployment's write budget
 * (8 MiB a second on dev, shared with every user's writes) in one burst.
 */
const PART_WRITE_SPACING_MS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type BuildArgs = {
  reportId: string;
  tenantId: Id<"tenants">;
  filtersJson: string;
  range: ResolvedAnalyticsRange;
};

/**
 * Fetches a Node-built report's rows, reads its context and builds its
 * answer. A context that doesn't need the rows loads first, so the SQL can
 * use it (current worker ownership, for example).
 */
type Built = { payloadJson: string; rowsChars: number; ms: number };

async function buildReportInNode(ctx: ActionCtx, args: BuildArgs): Promise<Built> {
  const started = Date.now();
  const definition = getReportDefinition(args.reportId);
  const node = definition.node;
  if (!node) throw new Error(`${args.reportId} doesn't build in Node.`);
  const input = {
    tenantId: args.tenantId,
    filters: JSON.parse(args.filtersJson) as AnalyticsFilters,
    range: args.range,
  };
  const loadContext = async (keys: string[]): Promise<unknown> => {
    const json: string = await ctx.runQuery(internal.analytics.results.reportContext, {
      reportId: args.reportId,
      tenantId: args.tenantId,
      filtersJson: args.filtersJson,
      range: args.range,
      keys,
    });
    return JSON.parse(json) as unknown;
  };
  const early: unknown = node.keys ? undefined : await loadContext([]);
  const budget: RowsBudget = { remainingChars: MAX_NODE_ROWS_CHARS };
  const rows: Record<string, SqlRow[]> = {};
  for (const [name, query] of Object.entries(definition.sql(input, early))) {
    rows[name] = await queryTenantClickHouse(args.tenantId, query, budget);
  }
  const context: unknown = early !== undefined ? early : await loadContext(node.keys!(rows));
  const payloadJson: string = JSON.stringify(node.build({ ...input, rows, context }));
  return {
    payloadJson,
    rowsChars: MAX_NODE_ROWS_CHARS - budget.remainingChars,
    ms: Date.now() - started,
  };
}

type Outcome = { ok: true; saved: boolean } | { ok: false; errorMessage: string };

const outcomeValidator = v.union(
  v.object({ ok: v.literal(true), saved: v.boolean() }),
  v.object({ ok: v.literal(false), errorMessage: v.string() }),
);

/**
 * Builds a run's answer and saves it through `complete`, so the answer never
 * passes through the V8 action that started the run. Returns the message to
 * record on failure; errors are reported here, where their stack survives.
 */
export const finalizeInNode = internalAction({
  args: {
    resultId: v.id("analyticsResults"),
    runId: v.string(),
    watermark: v.number(),
    reportId: v.string(),
    tenantId: v.id("tenants"),
    filtersJson: v.string(),
    range: resolvedRangeValidator,
  },
  returns: outcomeValidator,
  handler: async (ctx, args): Promise<Outcome> => {
    try {
      const built: Built = await buildReportInNode(ctx, args);
      const bytes = answerBytes(built.payloadJson);
      log.info("analytics.node_build", {
        reportId: args.reportId,
        rowsChars: built.rowsChars,
        answerBytes: bytes,
        ms: built.ms,
        maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
      });
      if (bytes > MAX_ANSWER_BYTES) return { ok: false as const, errorMessage: ANSWER_TOO_LARGE };
      const parts = splitPayload(built.payloadJson);
      const stored: Id<"analyticsPayloads">[] = [];
      let saved = false;
      try {
        for (const [index, json] of parts.entries()) {
          if (index > 0) await sleep(PART_WRITE_SPACING_MS);
          const id: Id<"analyticsPayloads"> | null = await ctx.runMutation(internal.analytics.results.storePayloadPart, {
            resultId: args.resultId,
            runId: args.runId,
            json,
          });
          // A newer run replaced this one; it saves its own answer.
          if (id === null) break;
          stored.push(id);
        }
        if (stored.length === parts.length) {
          ({ saved } = await ctx.runMutation(internal.analytics.results.complete, {
            resultId: args.resultId,
            runId: args.runId,
            watermark: args.watermark,
            range: args.range,
            payloadPartIds: stored,
          }));
        }
      } finally {
        if (!saved && stored.length > 0) {
          await ctx.runMutation(internal.analytics.results.deletePayloadParts, { ids: stored });
        }
      }
      return { ok: true as const, saved };
    } catch (error) {
      if (error instanceof RowsBudgetExceededError) return { ok: false as const, errorMessage: error.message };
      if (error instanceof ClickHouseNotConfiguredError) return { ok: false as const, errorMessage: error.message };
      reportError("analytics.report_failed", error, {
        reportId: args.reportId,
        tenantId: args.tenantId,
        fingerprint: `analytics.report_failed:${args.reportId}`,
      });
      return { ok: false as const, errorMessage: FAILED };
    }
  },
});

/**
 * The same build, without saving, for `pnpm analytics:parity`. Throws when
 * the answer is over the cap `complete` applies.
 */
export const previewInNode = internalAction({
  args: {
    reportId: v.string(),
    tenantId: v.id("tenants"),
    filtersJson: v.string(),
    range: resolvedRangeValidator,
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const built: Built = await buildReportInNode(ctx, args);
    if (answerBytes(built.payloadJson) > MAX_ANSWER_BYTES) throw new Error(ANSWER_TOO_LARGE);
    return built.payloadJson;
  },
});

/**
 * The admin assistant's Node build: the answer is stored in parts under the
 * request's run and only the part count comes back, so a multi-megabyte answer
 * never passes through the V8 runner or into one document.
 */
export const storeAssistantAnswer = internalAction({
  args: {
    requestId: v.id("mcpReportRequests"),
    runToken: v.string(),
    reportId: v.string(),
    tenantId: v.id("tenants"),
    filtersJson: v.string(),
    range: resolvedRangeValidator,
  },
  returns: v.number(),
  handler: async (ctx, { requestId, runToken, ...build }): Promise<number> => {
    const built: Built = await buildReportInNode(ctx, build);
    log.info("mcp.node_build", {
      reportId: build.reportId,
      tenantId: build.tenantId,
      rowsChars: built.rowsChars,
      answerBytes: answerBytes(built.payloadJson),
      ms: built.ms,
    });
    return await storeAnswerParts(ctx, { requestId, runToken }, built.payloadJson);
  },
});

// Read-only parity actions. Existing production builds above stay unchanged.
import { AsyncLocalStorage } from "node:async_hooks";
import { queryWatermark, registerClickHouseAttemptScope, type ClickHouseAttemptHook } from "./clickhouse";
import { fetchReportRows } from "./run";
import { cappedBy, differences, canonical } from "../../scripts/analytics-parity-core.mjs";

const parityAttemptScope = new AsyncLocalStorage<ClickHouseAttemptHook>();
registerClickHouseAttemptScope(parityAttemptScope);

const PARITY_LIMITATION = "Clock and Convex dimension context are not frozen. Unequal answers are rebuilt once; only identical differences present in both builds are reported. Warehouse watermarks bracket all builds; a changed watermark discards the comparison and retries once. Equal watermarks do not guarantee a transactional warehouse snapshot. Query seconds conservatively charge round-trip time, capped at the server's 30-second execution limit; each attempt reserves 30 seconds before starting. The CLI budget is shared locally, not across machines or other warehouse clients.";

type ParityAttempt = { at: number; seconds: number; retry: boolean };

/** Builds active and candidate back to back, without saving either answer. */
export const compareInNode = internalAction({
  args: {
    tenantId: v.id("tenants"),
    reportId: v.string(),
    candidateId: v.optional(v.string()),
    filtersJson: v.string(),
    range: resolvedRangeValidator,
    maxQueries: v.number(),
    maxSeconds: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const attempts: ParityAttempt[] = [];
    let builds = 0;
    let discarded = 0;
    let repeated = 0;
    const hook: ClickHouseAttemptHook = {
      beforeAttempt: retry => {
        const seconds = attempts.reduce((total, attempt) => total + attempt.seconds, 0);
        if (!Number.isFinite(args.maxQueries) || !Number.isFinite(args.maxSeconds) ||
          attempts.length + 1 > args.maxQueries || seconds + 30 > args.maxSeconds) {
          throw new Error("incomplete verification: hourly ClickHouse query budget would be exceeded");
        }
        attempts.push({ at: Date.now(), seconds: 0, retry });
      },
      afterAttempt: ms => { attempts[attempts.length - 1].seconds = Math.min(30, Math.max(0, ms / 1000)); },
      onResponseError: (text, status, code) => {
        if (code === "202" || code === "201" || /QUOTA_EXCEEDED|TOO_MANY_SIMULTANEOUS_QUERIES|quota/i.test(text)) {
          throw new Error(`incomplete verification: warehouse quota or concurrency error (${status}, ${code ?? "unknown"}): ${text}`);
        }
      },
    };
    const build = async (reportId: string): Promise<unknown> => {
      builds += 1;
      const definition = getReportDefinition(reportId);
      const input = { ...args, reportId };
      let json: string;
      if (definition.node) {
        const built = await buildReportInNode(ctx, input);
        json = built.payloadJson;
      } else {
        const rowsJson = await fetchReportRows(definition, {
          tenantId: args.tenantId, filters: JSON.parse(args.filtersJson) as AnalyticsFilters, range: args.range,
        });
        json = await ctx.runQuery(internal.analytics.results.previewFinalize, {
          reportId, tenantId: args.tenantId, filtersJson: args.filtersJson, range: args.range, rowsJson,
        });
      }
      if (answerBytes(json) > MAX_ANSWER_BYTES) throw new Error(ANSWER_TOO_LARGE);
      const answer: unknown = JSON.parse(json);
      const cap = cappedBy(answer);
      if (cap) throw new Error(`incomplete verification: ${reportId} is capped (${cap})`);
      return answer;
    };
    const usage = () => ({ attempts, queries: attempts.length,
      retries: attempts.filter(attempt => attempt.retry).length,
      seconds: attempts.reduce((total, attempt) => total + attempt.seconds, 0), builds, discarded, repeated });
    return await parityAttemptScope.run(hook, async () => {
      try {
        for (let syncTry = 0; syncTry < 2; syncTry += 1) {
          const before = await queryWatermark();
          if (before === null) throw new Error("incomplete verification: warehouse has no watermark");
          let active = await build(args.reportId);
          let candidate = args.candidateId ? await build(args.candidateId) : null;
          let diff = args.candidateId ? differences(active, candidate, "", [], Number.POSITIVE_INFINITY) : [];
          let unstable = 0;
          if (diff.length > 0) {
            repeated += 1;
            const first = new Set(diff.map(entry => JSON.stringify(canonical(entry))));
            active = await build(args.reportId);
            candidate = await build(args.candidateId!);
            const again = differences(active, candidate, "", [], Number.POSITIVE_INFINITY);
            diff = again.filter(entry => first.has(JSON.stringify(canonical(entry))));
            unstable = again.length - diff.length;
          }
          const after = await queryWatermark();
          if (before !== after) {
            discarded += 1;
            if (syncTry === 0) continue;
            throw new Error("incomplete verification: a sync landed during both comparison attempts");
          }
          return JSON.stringify({ status: unstable > 0 ? "incomplete" : "complete",
            ...(unstable > 0 ? { error: "incomplete verification: repeated differences changed with clock or context" } : {}),
            // Two 12 MB answers can exceed an action's return limit. Compare
            // mode returns only its canonical diff and answer sizes.
            ...(!args.candidateId ? { active } : {}),
            answers: { activeBytes: answerBytes(JSON.stringify(active)),
              candidateBytes: args.candidateId ? answerBytes(JSON.stringify(candidate)) : 0 },
            differences: diff.slice(0, 20), differenceCount: diff.length,
            unstable, watermark: before, usage: usage(), limitation: PARITY_LIMITATION });
        }
        throw new Error("incomplete verification: no stable comparison");
      } catch (error) {
        return JSON.stringify({ status: "incomplete", error: error instanceof Error ? error.message : String(error),
          usage: usage(), limitation: PARITY_LIMITATION });
      }
    });
  },
});
