import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { env, httpAction, internalMutation, internalQuery } from "../_generated/server";
import { log } from "../lib/observability/log";
import { hmacSha256Hex, timingSafeEqualString } from "../lib/webCrypto";
import {
  answerCoversPeriod,
  HOUR_MS,
  KEY_TTL_MS,
  readSyncRow,
  runIsInFlight,
  startRun,
} from "./results";

/** A sync older than this raises `analytics.sync_stale` and the delayed banner. */
export const STALE_SYNC_MS = 8 * HOUR_MS;
const STALE_REPORT_INTERVAL_MS = 6 * HOUR_MS;
const CLEANUP_BATCH = 200;
const SIGNATURE_HEADER = "x-fivetran-signature-256";

/**
 * Every 5 minutes: stamp the heartbeat Fivetran copies to ClickHouse, and
 * report a sync that hasn't finished in 8 hours.
 */
export const beat = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const row = await readSyncRow(ctx);
    if (!row) {
      await ctx.db.insert("analyticsSync", { beatAt: now });
      return null;
    }
    const stale =
      row.lastSyncEndedAt !== undefined &&
      now - row.lastSyncEndedAt > STALE_SYNC_MS &&
      (row.staleReportedAt === undefined || now - row.staleReportedAt > STALE_REPORT_INTERVAL_MS);
    if (stale) {
      log.error("analytics.sync_stale", {
        lastSyncEndedAt: row.lastSyncEndedAt,
        lastSyncStatus: row.lastSyncStatus,
        hoursSinceSync: Math.round((now - row.lastSyncEndedAt!) / HOUR_MS),
      });
    }
    await ctx.db.patch("analyticsSync", row._id, {
      beatAt: now,
      ...(stale ? { staleReportedAt: now } : {}),
    });
    return null;
  },
});

/** One Fivetran `sync_end`. A repeated delivery of the same sync is a no-op. */
export const recordSyncEnd = internalMutation({
  args: {
    syncId: v.string(),
    status: v.string(),
    endedAt: v.number(),
  },
  returns: v.object({ batchStarted: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await readSyncRow(ctx);
    if (row?.lastSyncId === args.syncId) return { batchStarted: false };
    const successful = args.status === "SUCCESSFUL";
    const patch = {
      lastSyncId: args.syncId,
      lastSyncStatus: args.status,
      ...(successful ? { lastSyncEndedAt: args.endedAt } : {}),
    };
    if (row) {
      await ctx.db.patch("analyticsSync", row._id, patch);
    } else {
      await ctx.db.insert("analyticsSync", { beatAt: Date.now(), ...patch });
    }
    log.info("analytics.sync_ended", { syncId: args.syncId, status: args.status });
    if (!successful) return { batchStarted: false };
    await ctx.scheduler.runAfter(0, internal.analytics.run.runPostSyncBatch, {});
    return { batchStarted: true };
  },
});

/** Records the batch's watermark. `changed` is false when the sync added nothing. */
export const startBatch = internalMutation({
  args: { watermark: v.number() },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, { watermark }) => {
    const now = Date.now();
    const row = await readSyncRow(ctx);
    const changed = (row?.watermark ?? 0) < watermark;
    const patch = {
      lastBatchStartedAt: now,
      ...(changed ? { watermark } : {}),
    };
    if (row) await ctx.db.patch("analyticsSync", row._id, patch);
    else await ctx.db.insert("analyticsSync", { beatAt: now, ...patch });
    return { changed };
  },
});

/** Keys opened since `since`, newest first. */
export const recentKeys = internalQuery({
  args: { since: v.number(), paginationOpts: paginationOptsValidator },
  returns: v.object({
    keys: v.array(v.object({ resultId: v.id("analyticsResults"), tenantId: v.id("tenants") })),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { since, paginationOpts }) => {
    const page = await ctx.db
      .query("analyticsResults")
      .withIndex("by_lastRequestedAt", (q) => q.gte("lastRequestedAt", since))
      .order("desc")
      .paginate(paginationOpts);
    return {
      keys: page.page.map((row) => ({ resultId: row._id, tenantId: row.tenantId })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * Starts the batch's run for one key, unless its answer already covers this
 * watermark or a run is in flight. Batch runs don't count against the budget.
 */
export const startBatchRun = internalMutation({
  args: { resultId: v.id("analyticsResults"), watermark: v.number() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { resultId, watermark }) => {
    const row = await ctx.db.get("analyticsResults", resultId);
    if (!row) return null;
    const now = Date.now();
    if (runIsInFlight(row, now)) return null;
    if (
      row.status === "ready" &&
      row.answer !== undefined &&
      row.answer.watermark >= watermark &&
      answerCoversPeriod(row, now)
    ) {
      return null;
    }
    return await startRun(ctx, row, { watermark, now, miss: false });
  },
});

/** Deletes keys nobody opened in 14 days and stamps the batch's end. */
export const finishBatch = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("analyticsResults")
      .withIndex("by_lastRequestedAt", (q) => q.lt("lastRequestedAt", now - KEY_TTL_MS))
      .take(CLEANUP_BATCH);
    for (const row of expired) {
      await ctx.db.delete("analyticsResults", row._id);
    }
    const sync = await readSyncRow(ctx);
    if (sync) await ctx.db.patch("analyticsSync", sync._id, { lastBatchAt: now });
    log.info("analytics.batch_finished", { expiredKeys: expired.length });
    return null;
  },
});

type FivetranEvent = {
  event?: unknown;
  created?: unknown;
  connector_id?: unknown;
  connection_id?: unknown;
  sync_id?: unknown;
  data?: { status?: unknown } | null;
};

/**
 * `POST /analytics/fivetran`: Fivetran's webhook, signed with HMAC-SHA256 of
 * the raw body in `X-Fivetran-Signature-256`. Answers within Fivetran's 10 s
 * limit and leaves the batch to the scheduler.
 */
export const fivetranWebhook = httpAction(async (ctx, request) => {
  const secret = env.FIVETRAN_WEBHOOK_SECRET;
  if (!secret) {
    log.warn("analytics.fivetran.rejected", { reason: "missing_secret" });
    return new Response("Not configured", { status: 503 });
  }
  const rawBody = await request.text();
  const signature = (request.headers.get(SIGNATURE_HEADER) ?? "").trim().toLowerCase();
  const expected = await hmacSha256Hex(secret, rawBody);
  if (!timingSafeEqualString(expected, signature)) {
    log.warn("analytics.fivetran.rejected", { reason: "signature_mismatch" });
    return new Response("Invalid signature", { status: 401 });
  }

  let body: FivetranEvent;
  try {
    body = JSON.parse(rawBody) as FivetranEvent;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (body.event !== "sync_end") return new Response("Ignored", { status: 200 });

  const connectorId = String(body.connector_id ?? body.connection_id ?? "");
  // Fivetran's test delivery uses a dummy connection, `_connection_1`.
  if (connectorId.startsWith("_connection_")) {
    log.info("analytics.fivetran.test_received", { connectorId });
    return new Response("Test received", { status: 200 });
  }
  const created = typeof body.created === "string" ? Date.parse(body.created) : Number.NaN;
  const syncId =
    typeof body.sync_id === "string" && body.sync_id
      ? body.sync_id
      : `${connectorId}:${String(body.created ?? "")}`;
  await ctx.runMutation(internal.analytics.sync.recordSyncEnd, {
    syncId,
    status: String(body.data?.status ?? "UNKNOWN"),
    endedAt: Number.isFinite(created) ? created : Date.now(),
  });
  return new Response("OK", { status: 200 });
});
