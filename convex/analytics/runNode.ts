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

// The Node build path (docs/agents/reporting.md): reports whose rows are too
// large to pass into the `complete` mutation, or whose build needs more than
// a mutation's CPU, build here. The rows never leave this action; only the
// answer, split into parts, goes to `complete`. Node actions have 512 MiB.

/**
 * Characters of ClickHouse response text one report may read. About 3.5x
 * the largest report a year of production data needed in November 2026
 * (People's lead gen, about 6.8M); peak memory at this budget was measured
 * well under half of Node's 512 MiB.
 */
export const MAX_NODE_ROWS_CHARS = 24_000_000;

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
