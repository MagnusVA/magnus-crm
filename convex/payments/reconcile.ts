import { internal } from "../_generated/api";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { log } from "../lib/observability/log";
import { providerPool } from "../pipeline/workpools";
import { refreshWhopPaymentForSweep } from "./intake";
import { RAW_RECEIPT_BATCH } from "./schema";
import { reportWhopRequestError, WhopRequestError, type WhopQuery } from "./whop/client";
import { WhopAccountMismatch, whopFetch } from "./whop/connectionFetch";
import { whopId } from "./whop/normalize";

const PAGE_SIZE = 20;
export const SWEEP_PAGE_BUDGET = 64;
const PROVISIONAL_RETRY_AGE_MS = 15 * 60_000;
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

const KNOWN_STATUSES = ["draft", "open", "pending", "authorized", "unresolved"] as const;
const OPEN_ADVERSE_STATES = ["refund_pending", "dispute_open"] as const;
const knownStatus = v.union(
  v.literal("draft"), v.literal("open"), v.literal("pending"), v.literal("authorized"), v.literal("unresolved"),
);
const openAdverseState = v.union(v.literal("refund_pending"), v.literal("dispute_open"));

export const listKnownPayments = internalQuery({
  args: {
    connectionId,
    paginationOpts: paginationOptsValidator,
    selector: v.union(
      v.object({ kind: v.literal("status"), value: knownStatus }),
      v.object({ kind: v.literal("adverse"), value: openAdverseState }),
      v.object({ kind: v.literal("fenced") }),
      v.object({ kind: v.literal("provisional"), firstSeenThrough: v.number() }),
    ),
  },
  returns: v.object({ ids: v.array(v.string()), cursor }),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (connection?.status !== "connected") return { ids: [], cursor: null };
    const selector = args.selector;
    const payments = ctx.db.query("providerPayments");
    const index = (() => {
      switch (selector.kind) {
        case "status":
          return payments.withIndex("by_connectionId_and_status_and_sourceCreatedAt_and_firstSeenAt",
            (q) => q.eq("connectionId", connection._id).eq("status", selector.value));
        case "provisional":
          return payments.withIndex("by_connectionId_and_status_and_sourceCreatedAt_and_firstSeenAt",
            (q) => q.eq("connectionId", connection._id).eq("status", "unknown")
              .eq("sourceCreatedAt", 0).lte("firstSeenAt", selector.firstSeenThrough));
        case "adverse":
          return payments.withIndex("by_connectionId_and_adverseState_and_adverseFencedAt",
            (q) => q.eq("connectionId", connection._id).eq("adverseState", selector.value)
              .eq("adverseFencedAt", undefined));
        case "fenced":
          return payments.withIndex("by_connectionId_and_adverseFencedAt",
            (q) => q.eq("connectionId", connection._id).gt("adverseFencedAt", undefined));
      }
    })();
    const page = await index.paginate({
      ...args.paginationOpts,
      numItems: Math.min(PAGE_SIZE, args.paginationOpts.numItems),
    });
    const ids = page.page.filter((row) => row.tenantId === connection.tenantId).map((row) => row.externalPaymentId);
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
    if (page.page_info.has_next_page && !nextCursor)
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
  ...OPEN_ADVERSE_STATES.map((value) => ({ kind: "adverse" as const, value })),
  { kind: "fenced" },
  { kind: "provisional" },
] as const;

export const recordUnreadablePayments = internalMutation({
  args: { connectionId, connectedAt: v.number(), ids: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (row?.connectedAt === args.connectedAt) {
      const unreadable = new Set(args.ids);
      const prior = row.unreadablePaymentIds?.filter((id) => !unreadable.has(id)) ?? [];
      const ids = [...prior, ...unreadable].slice(-25);
      await ctx.db.patch("tenantPaymentConnections", args.connectionId, { unreadablePaymentIds: ids });
    }
    return null;
  },
});

async function refreshPage(
  ctx: ActionCtx,
  connection: Doc<"tenantPaymentConnections">,
  ids: string[],
) {
  const unreadable: string[] = [];
  try {
    for (const id of new Set(ids)) {
      try {
        const result = await refreshWhopPaymentForSweep(ctx, connection, id);
        if (result === "superseded") unreadable.push(id);
      } catch (error) {
        if (!(error instanceof WhopRequestError) || error.code !== "unexpected_response" ||
            (error.status !== undefined && error.status !== 404 && error.status >= 300)) throw error;
        unreadable.push(id);
      }
    }
  } finally {
    if (unreadable.length) {
      await ctx.runMutation(internal.payments.reconcile.recordUnreadablePayments, {
        connectionId: connection._id, connectedAt: connection.connectedAt, ids: unreadable,
      });
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
  reportWhopRequestError("whop.reconcile.failed", error, { connectionId, kind, code });
}

const progress = v.union(
  v.object({ kind: v.literal("recent"), through: v.number(), stage: v.number(), cursor }),
  v.object({ kind: v.literal("full"), startedAt: v.number(), cursor: v.string() }),
);

const runBudget = {
  pages: v.optional(v.number()),
  seenCursors: v.optional(v.array(v.string())),
};

export const checkpointPage = internalMutation({
  args: {
    connectionId, connectedAt: v.number(), token: v.string(),
    progress, pages: v.number(), seenCursors: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (row?.status !== "connected" || row.connectedAt !== args.connectedAt ||
        row.sweepToken !== args.token) return null;
    const { connectionId, token, progress, pages, seenCursors } = args;
    const exhausted = pages >= SWEEP_PAGE_BUDGET;
    const lease = exhausted ? { sweepToken: undefined, sweepUntil: undefined } : {};
    if (progress.kind === "recent") {
      const { through, stage, cursor } = progress;
      await ctx.db.patch("tenantPaymentConnections", connectionId, {
        ...lease, recentSweepProgress: { through, stage, cursor },
      });
      if (!exhausted) {
        await providerPool.enqueueAction(ctx, internal.payments.reconcile.sweepRecent, {
          connectionId, through, token, stage, cursor, pages, seenCursors,
        });
      }
    } else {
      const { startedAt, cursor } = progress;
      await ctx.db.patch("tenantPaymentConnections", connectionId, {
        ...lease, fullScanStartedAt: startedAt, fullScanCursor: cursor,
      });
      if (!exhausted) {
        await providerPool.enqueueAction(ctx, internal.payments.reconcile.scanFull, {
          connectionId, startedAt, token, pages, seenCursors,
        });
      }
    }
    if (exhausted) log.info("whop.reconcile.incomplete", { connectionId, code: "page_budget" });
    return null;
  },
});

export const sweepRecent = internalAction({
  args: {
    connectionId,
    through: v.number(),
    token: v.optional(v.string()),
    stage: v.optional(v.number()),
    cursor: v.optional(cursor),
    ...runBudget,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const token = args.token ?? crypto.randomUUID();
    const lease = await ctx.runMutation(internal.payments.connectionState.takeSweepLease, {
      connectionId: args.connectionId, token, continuation: args.token !== undefined,
      recentThrough: args.token === undefined ? args.through : undefined,
    });
    if (lease !== "acquired") return null;

    const connection = await ctx.runQuery(internal.payments.connectionState.connection, {
      connectionId: args.connectionId,
    });
    if (!connection || connection.sweepToken !== token) return null;
    const leaseArgs = { connectionId: connection._id, connectedAt: connection.connectedAt, token };
    const continuation = args.token ? undefined : connection.recentSweepProgress;
    const through = continuation?.through ?? args.through;
    const stageIndex = continuation?.stage ?? args.stage ?? 0;
    const pageCursor = continuation?.cursor ?? args.cursor ?? null;
    try {
      if (!args.token && connection.unreadablePaymentIds?.length) {
        await refreshPage(ctx, connection, connection.unreadablePaymentIds);
      }
      if ((connection.sweepCreatedThrough ?? 0) >= through) {
        await ctx.runMutation(internal.payments.connectionState.releaseSweepLease, leaseArgs);
        return null;
      }
      const stage = RECENT_STAGES[stageIndex];
      const from = Math.max(0, (connection.sweepCreatedThrough ?? connection.connectedAt) - SWEEP_OVERLAP_MS);
      const page = stage.kind === "window"
        ? await listPayments(ctx, connection, {
          [stage.after]: new Date(from).toISOString(),
          [stage.before]: new Date(through).toISOString(),
        }, pageCursor)
        : await ctx.runQuery(internal.payments.reconcile.listKnownPayments, {
          connectionId: connection._id,
          selector: stage.kind === "provisional"
            ? { ...stage, firstSeenThrough: through - PROVISIONAL_RETRY_AGE_MS }
            : stage,
          paginationOpts: { cursor: pageCursor, numItems: PAGE_SIZE },
        });
      const seenCursors = args.seenCursors ?? (pageCursor ? [pageCursor] : []);
      if (page.cursor && seenCursors.includes(page.cursor)) {
        await ctx.runMutation(internal.payments.connectionState.releaseSweepLease, {
          ...leaseArgs, checkpoint: { kind: "recent_reset" },
        });
        log.warn("whop.reconcile.incomplete", { connectionId: connection._id, code: "cursor_cycle" });
        return null;
      }
      await refreshPage(ctx, connection, page.ids);
      const nextStage = page.cursor ? stageIndex : stageIndex + 1;
      if (nextStage < RECENT_STAGES.length) {
        await ctx.runMutation(internal.payments.reconcile.checkpointPage, {
          ...leaseArgs,
          progress: { kind: "recent", through, stage: nextStage, cursor: page.cursor },
          pages: (args.pages ?? 0) + 1,
          seenCursors: page.cursor ? [...seenCursors, page.cursor] : [],
        });
      } else {
        const saved = await ctx.runMutation(internal.payments.connectionState.releaseSweepLease, {
          ...leaseArgs, checkpoint: { kind: "recent", through },
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
  args: { connectionId, startedAt: v.number(), token: v.optional(v.string()), ...runBudget },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const token = args.token ?? crypto.randomUUID();
    const lease = await ctx.runMutation(internal.payments.connectionState.takeSweepLease, {
      connectionId: args.connectionId, token, continuation: args.token !== undefined,
    });
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
      const pageCursor = connection.fullScanCursor ?? null;
      const page = await listPayments(ctx, connection, {
        created_before: new Date(scanStartedAt).toISOString(),
      }, pageCursor);
      const seenCursors = args.seenCursors ?? (pageCursor ? [pageCursor] : []);
      if (page.cursor && seenCursors.includes(page.cursor)) {
        await ctx.runMutation(internal.payments.connectionState.releaseSweepLease, leaseArgs);
        log.warn("whop.reconcile.incomplete", { connectionId: connection._id, code: "cursor_cycle" });
        return null;
      }
      await refreshPage(ctx, connection, page.ids);
      if (page.cursor) {
        await ctx.runMutation(internal.payments.reconcile.checkpointPage, {
          ...leaseArgs,
          progress: { kind: "full", startedAt: scanStartedAt, cursor: page.cursor },
          pages: (args.pages ?? 0) + 1,
          seenCursors: [...seenCursors, page.cursor],
        });
      } else {
        const saved = await ctx.runMutation(internal.payments.connectionState.releaseSweepLease, {
          ...leaseArgs,
          checkpoint: { kind: "full", startedAt: scanStartedAt, cursor: null },
        });
        if (saved) log.info("whop.reconcile.full_scan_completed", { connectionId: connection._id });
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
    payersDone: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const asOf = args.asOf ?? Date.now();
    let bodyCount = 0;
    let payerCount = 0;
    let receiptsDone = args.receiptsDone ?? false;
    let payersDone = args.payersDone ?? false;
    if (!receiptsDone) {
      const rows = await ctx.db.query("paymentWebhookReceipts")
        .withIndex("by_hasRawBody_and_receivedAt",
          (q) => q.eq("hasRawBody", true).lte("receivedAt", asOf - 7 * DAY_MS))
        .take(RAW_RECEIPT_BATCH);
      for (const row of rows) {
        await ctx.db.patch("paymentWebhookReceipts", row._id, {
          rawBody: undefined, hasRawBody: undefined, rawBodyDeletedAt: asOf,
        });
      }
      bodyCount = rows.length;
      receiptsDone = rows.length < RAW_RECEIPT_BATCH;
    }
    if (!payersDone) {
      const payments = await ctx.db.query("providerPayments")
        .withIndex("by_hasPayerDetails_and_payerDetailsExpireAt", (q) =>
          q.eq("hasPayerDetails", true).gt("payerDetailsExpireAt", undefined).lte("payerDetailsExpireAt", asOf))
        .take(RETENTION_BATCH);
      for (const row of payments) {
        await ctx.db.patch("providerPayments", row._id, {
          payerEmail: undefined, payerPhone: undefined, hasPayerDetails: undefined, payerDetailsClearedAt: asOf,
        });
      }
      payerCount = payments.length;
      payersDone = payments.length < RETENTION_BATCH;
    }
    const continued = !receiptsDone || !payersDone;
    if (continued) {
      await ctx.scheduler.runAfter(0, internal.payments.reconcile.purge, {
        asOf, receiptsDone, payersDone,
      });
    }
    log.info("whop.retention.batch", { bodyCount, payerCount, continued });
    return null;
  },
});
