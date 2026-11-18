import { internal } from "../_generated/api";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { log, reportError } from "../lib/observability/log";
import { providerPool } from "../pipeline/workpools";
import { refreshWhopPayment } from "./intake";
import { WhopRequestError, type WhopQuery } from "./whop/client";
import { WhopAccountMismatch, whopFetch } from "./whop/connectionFetch";
import { whopId } from "./whop/normalize";

const PAGE_SIZE = 20;
const DAY_MS = 86_400_000;
export const SWEEP_OVERLAP_MS = 30 * 60_000;
const connectionId = v.id("tenantPaymentConnections");
const cursor = v.union(v.string(), v.null());
const sweepKind = v.union(v.literal("recent"), v.literal("full"));

export const sweep = internalMutation({
  args: { kind: sweepKind, cursor: v.optional(cursor), startedAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const startedAt = args.startedAt ?? Date.now();
    const connections = await ctx.db.query("tenantPaymentConnections")
      .withIndex("by_status", (q) => q.eq("status", "connected"))
      .paginate({ cursor: args.cursor ?? null, numItems: 25 });
    for (const connection of connections.page) {
      if (args.kind === "recent") {
        await providerPool.enqueueAction(ctx, internal.payments.reconcile.sweepRecent, {
          connectionId: connection._id, through: startedAt,
        });
      } else {
        await providerPool.enqueueAction(ctx, internal.payments.reconcile.scanFull, {
          connectionId: connection._id, startedAt,
        });
      }
    }
    if (!connections.isDone)
      await ctx.scheduler.runAfter(0, internal.payments.reconcile.sweep, {
        kind: args.kind, cursor: connections.continueCursor, startedAt,
      });
    return null;
  },
});

const KNOWN_STATUSES = ["open", "pending", "authorized", "unresolved"] as const;
const KNOWN_ADVERSE_STATES = [
  "refund_pending", "dispute_open", "partially_refunded", "refunded", "dispute_won", "dispute_lost",
] as const;
const knownStatus = v.union(
  v.literal("open"), v.literal("pending"), v.literal("authorized"), v.literal("unresolved"),
);
const knownAdverseState = v.union(
  v.literal("refund_pending"), v.literal("dispute_open"), v.literal("partially_refunded"),
  v.literal("refunded"), v.literal("dispute_won"), v.literal("dispute_lost"),
);

export const listKnownPayments = internalQuery({
  args: {
    connectionId,
    paginationOpts: paginationOptsValidator,
    selector: v.union(
      v.object({ kind: v.literal("status"), value: knownStatus }),
      v.object({ kind: v.literal("adverse"), value: knownAdverseState }),
    ),
  },
  returns: v.object({ ids: v.array(v.string()), cursor }),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (connection?.status !== "connected") return { ids: [], cursor: null };
    const selector = args.selector;
    const page = await (selector.kind === "status"
      ? ctx.db.query("providerPayments").withIndex("by_connectionId_and_status_and_sourceCreatedAt",
        (q) => q.eq("connectionId", connection._id).eq("status", selector.value))
      : ctx.db.query("providerPayments").withIndex("by_connectionId_and_adverseState",
        (q) => q.eq("connectionId", connection._id).eq("adverseState", selector.value)))
      .paginate({ ...args.paginationOpts, numItems: Math.min(PAGE_SIZE, args.paginationOpts.numItems) });
    const ids = [];
    for (const row of page.page) {
      if (row.tenantId !== connection.tenantId) continue;
      if (selector.kind === "status" || selector.value === "refund_pending" ||
        selector.value === "dispute_open" || row.adverseFencedAt !== undefined) {
        ids.push(row.externalPaymentId);
      }
    }
    return { ids, cursor: page.isDone ? null : page.continueCursor };
  },
});

const paymentPageSchema = z.object({
  data: z.array(z.object({ id: whopId, account_id: whopId.nullable() })).max(PAGE_SIZE),
  page_info: z.object({
    has_next_page: z.boolean(),
    end_cursor: z.string().min(1).max(4096).nullable(),
  }),
});

async function listPayments(
  ctx: ActionCtx,
  connection: Doc<"tenantPaymentConnections">,
  query: WhopQuery,
  pageCursor: string | null,
) {
  return whopFetch(ctx, connection._id, "/payments", {
    connectedAt: connection.connectedAt,
    query: {
      mode: "account_sales",
      account_id: connection.accountId,
      order: "created_at",
      direction: "asc",
      first: PAGE_SIZE,
      after: pageCursor ?? undefined,
      ...query,
    },
  }, (response) => {
    const page = paymentPageSchema.parse(response);
    if (page.data.some((payment) => payment.account_id !== connection.accountId))
      throw new WhopAccountMismatch();
    const nextCursor = page.page_info.has_next_page ? page.page_info.end_cursor : null;
    if (page.page_info.has_next_page && (!nextCursor || nextCursor === pageCursor))
      throw new WhopRequestError("unexpected_response");
    return { ids: page.data.map((payment) => payment.id), cursor: nextCursor };
  });
}

const WINDOWS = [
  ["created_after", "created_before"],
  ["refunded_after", "refunded_before"],
  ["dispute_created_after", "dispute_created_before"],
  ["dispute_alerted_after", "dispute_alerted_before"],
] as const;

const RECENT_STAGES = [
  ...WINDOWS.map(([after, before]) => ({ kind: "window" as const, after, before })),
  ...KNOWN_STATUSES.map((value) => ({ kind: "status" as const, value })),
  ...KNOWN_ADVERSE_STATES.map((value) => ({ kind: "adverse" as const, value })),
];

async function refreshPage(
  ctx: ActionCtx,
  connection: Doc<"tenantPaymentConnections">,
  ids: string[],
  known = false,
) {
  for (const id of new Set(ids)) {
    try {
      await refreshWhopPayment(ctx, connection, id);
    } catch (error) {
      // A previously known payment may no longer be visible at the provider.
      // Keep its last facts and continue refreshing the rest of the page.
      if (known && error instanceof WhopRequestError && error.status === 404) continue;
      throw error;
    }
  }
}

function reportSweepFailure(
  connectionId: Id<"tenantPaymentConnections">,
  kind: typeof sweepKind.type,
  error: unknown,
) {
  const code = error instanceof WhopAccountMismatch ? "account_mismatch"
    : error instanceof WhopRequestError ? error.code
    : "sweep_failed";
  reportError("whop.reconcile.failed", new Error("Whop reconciliation failed"), {
    integration: "whop", connectionId, kind, code,
  });
}

export const sweepRecent = internalAction({
  args: {
    connectionId,
    through: v.number(),
    token: v.optional(v.string()),
    stage: v.optional(v.number()),
    cursor: v.optional(cursor),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const token = args.token ?? crypto.randomUUID();
    const lease = await ctx.runMutation(internal.payments.connectionState.takeSweepLease, {
      connectionId: args.connectionId, token,
    });
    if (lease !== "acquired") return null;

    const connection = await ctx.runQuery(internal.payments.connectionState.connection, {
      connectionId: args.connectionId,
    });
    if (!connection || connection.sweepToken !== token) return null;
    const leaseArgs = { connectionId: connection._id, connectedAt: connection.connectedAt, token };
    if ((connection.sweepCreatedThrough ?? 0) >= args.through) {
      await ctx.runMutation(internal.payments.connectionState.releaseSweepLease, leaseArgs);
      return null;
    }
    try {
      const stageIndex = args.stage ?? 0;
      const stage = RECENT_STAGES[stageIndex];
      const pageCursor = args.cursor ?? null;
      const from = Math.max(0, (connection.sweepCreatedThrough ?? connection.connectedAt) - SWEEP_OVERLAP_MS);
      const page = stage.kind === "window"
        ? await listPayments(ctx, connection, {
          [stage.after]: new Date(from).toISOString(),
          [stage.before]: new Date(args.through).toISOString(),
        }, pageCursor)
        : await ctx.runQuery(internal.payments.reconcile.listKnownPayments, {
          connectionId: connection._id,
          selector: stage,
          paginationOpts: { cursor: pageCursor, numItems: PAGE_SIZE },
        });
      await refreshPage(ctx, connection, page.ids, stage.kind !== "window");
      const nextStage = page.cursor ? stageIndex : stageIndex + 1;
      if (nextStage < RECENT_STAGES.length) {
        await ctx.scheduler.runAfter(0, internal.payments.reconcile.sweepRecent, {
          connectionId: connection._id, through: args.through,
          token, stage: nextStage, cursor: page.cursor,
        });
      } else {
        const saved = await ctx.runMutation(internal.payments.connectionState.releaseSweepLease, {
          ...leaseArgs, checkpoint: { kind: "recent", through: args.through },
        });
        if (saved) log.info("whop.reconcile.sweep_completed", { connectionId: connection._id });
      }
    } catch (error) {
      await ctx.runMutation(internal.payments.connectionState.releaseSweepLease, leaseArgs);
      reportSweepFailure(connection._id, "recent", error);
    }
    return null;
  },
});

export const scanFull = internalAction({
  args: { connectionId, startedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const token = crypto.randomUUID();
    const lease = await ctx.runMutation(internal.payments.connectionState.takeSweepLease, {
      connectionId: args.connectionId, token,
    });
    if (lease === "busy") {
      await ctx.scheduler.runAfter(30_000, internal.payments.reconcile.scanFull, args);
      return null;
    }
    if (lease !== "acquired") return null;
    const connection = await ctx.runQuery(internal.payments.connectionState.connection, {
      connectionId: args.connectionId,
    });
    if (!connection || connection.sweepToken !== token) return null;
    const leaseArgs = { connectionId: connection._id, connectedAt: connection.connectedAt, token };
    if ((connection.lastFullScanAt ?? 0) >= args.startedAt) {
      await ctx.runMutation(internal.payments.connectionState.releaseSweepLease, leaseArgs);
      return null;
    }
    try {
      const scanStartedAt = connection.fullScanStartedAt ?? args.startedAt;
      const page = await listPayments(ctx, connection, {
        created_before: new Date(scanStartedAt).toISOString(),
      }, connection.fullScanCursor ?? null);
      await refreshPage(ctx, connection, page.ids);
      const saved = await ctx.runMutation(internal.payments.connectionState.releaseSweepLease, {
        ...leaseArgs,
        checkpoint: { kind: "full", startedAt: scanStartedAt, cursor: page.cursor },
      });
      if (saved && page.cursor) {
        await ctx.scheduler.runAfter(0, internal.payments.reconcile.scanFull, args);
      } else if (saved) {
        log.info("whop.reconcile.full_scan_completed", { connectionId: connection._id });
      }
    } catch (error) {
      await ctx.runMutation(internal.payments.connectionState.releaseSweepLease, leaseArgs);
      reportSweepFailure(connection._id, "full", error);
    }
    return null;
  },
});

const RETENTION_BATCH = 50;

export const purge = internalMutation({
  args: {
    asOf: v.optional(v.number()),
    receiptsDone: v.optional(v.boolean()),
    payerCursor: v.optional(cursor),
    payersDone: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const asOf = args.asOf ?? Date.now();
    let bodyCount = 0;
    let payerCount = 0;
    let receiptsDone = args.receiptsDone ?? false;
    let payersDone = args.payersDone ?? false;
    let payerCursor = args.payerCursor ?? null;
    if (!receiptsDone) {
      const rows = await ctx.db.query("paymentWebhookReceipts")
        .withIndex("by_rawBodyDeletedAt_and_receivedAt",
          (q) => q.eq("rawBodyDeletedAt", undefined).lte("receivedAt", asOf - 7 * DAY_MS))
        .take(RETENTION_BATCH);
      for (const row of rows) {
        if (row.rawBodyStorageId) {
          await ctx.storage.delete(row.rawBodyStorageId);
          bodyCount++;
        }
        await ctx.db.patch("paymentWebhookReceipts", row._id, {
          rawBodyStorageId: undefined,
          rawBodyDeletedAt: asOf,
        });
      }
      receiptsDone = rows.length < RETENTION_BATCH;
    }
    if (!payersDone) {
      const payments = await ctx.db.query("providerPayments")
        .withIndex("by_resolvedAt",
          (q) => q.gt("resolvedAt", undefined).lte("resolvedAt", asOf - 90 * DAY_MS))
        .paginate({ cursor: payerCursor, numItems: RETENTION_BATCH });
      for (const row of payments.page) {
        if (row.payerDetailsClearedAt !== undefined) continue;
        await ctx.db.patch("providerPayments", row._id, {
          payerEmail: undefined, payerPhone: undefined, payerDetailsClearedAt: asOf,
        });
        payerCount++;
      }
      payersDone = payments.isDone;
      payerCursor = payersDone ? null : payments.continueCursor;
    }
    const continued = !receiptsDone || !payersDone;
    if (continued) {
      await ctx.scheduler.runAfter(0, internal.payments.reconcile.purge, {
        asOf, receiptsDone, payerCursor, payersDone,
      });
    }
    log.info("whop.retention.batch", { bodyCount, payerCount, continued });
    return null;
  },
});
