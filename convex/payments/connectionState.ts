import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import {
  paymentConnectionErrorValidator,
  paymentProviderTables,
  providerEnvironmentValidator,
} from "./schema";

import { MAX_RETRY_AFTER_MS } from "./whop/client";

export const INVALID_SIGNATURE_WARNING_INTERVAL_MS = 60_000;

export const sampleInvalidSignature = internalMutation({
  args: { connectionId: v.id("tenantPaymentConnections") },
  returns: v.boolean(),
  handler: async (ctx, { connectionId }) => {
    const row = await ctx.db.get("tenantPaymentConnections", connectionId);
    const now = Date.now();
    if (!row || row.status === "disconnected" ||
        now - (row.lastInvalidSignatureWarningAt ?? -Infinity) < INVALID_SIGNATURE_WARNING_INTERVAL_MS) return false;
    await ctx.db.patch("tenantPaymentConnections", row._id, { lastInvalidSignatureWarningAt: now });
    return true;
  },
});

const connectionFields = paymentProviderTables.tenantPaymentConnections.validator.fields;
const connectionId = v.id("tenantPaymentConnections");
const REQUEST_SPACING_MS = 150;
export const SWEEP_LEASE_MS = 5 * 60_000;

export const connection = internalQuery({
  args: { connectionId: v.string() },
  returns: v.union(v.null(), v.object({
    ...connectionFields,
    _id: connectionId,
    _creationTime: v.number(),
  })),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("tenantPaymentConnections", args.connectionId);
    return id ? ctx.db.get("tenantPaymentConnections", id) : null;
  },
});

const credentials = v.object({
  environment: providerEnvironmentValidator,
  apiKey: v.string(),
  apiVersionDate: v.string(),
});

export const reserveRequest = internalMutation({
  args: { connectionId, connectedAt: v.number() },
  returns: v.union(
    v.object({ state: v.literal("unavailable") }),
    v.object({ state: v.literal("waiting"), retryAt: v.number() }),
    v.object({ state: v.literal("reserved"), requestedAt: v.number(), credentials }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (
      !row || row.status !== "connected" ||
      row.connectedAt !== args.connectedAt
    ) return { state: "unavailable" as const };
    const now = Date.now();
    // A caller gets its slot only when it can send, allowing a 429 from an
    // in-flight call to defer all callers still waiting for a slot.
    if (row.nextRequestAt !== undefined && row.nextRequestAt > now)
      return { state: "waiting" as const, retryAt: row.nextRequestAt };
    await ctx.db.patch("tenantPaymentConnections", row._id, {
      nextRequestAt: now + REQUEST_SPACING_MS,
    });
    return {
      state: "reserved" as const,
      requestedAt: now,
      credentials: {
        environment: row.environment,
        apiKey: row.apiKey,
        apiVersionDate: row.apiVersionDate,
      },
    };
  },
});

export const recordSuccess = internalMutation({
  args: { connectionId, connectedAt: v.number(), requestedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (
      row?.status === "connected" && row.connectedAt === args.connectedAt &&
      row.lastErrorAt !== undefined && args.requestedAt >= row.lastErrorAt
    ) {
      await ctx.db.patch("tenantPaymentConnections", row._id, {
        lastErrorCode: undefined,
        lastErrorAt: undefined,
      });
    }
    return null;
  },
});

export const recordFailure = internalMutation({
  args: {
    connectionId,
    connectedAt: v.number(),
    code: paymentConnectionErrorValidator,
    retryAfterMs: v.optional(v.number()),
    disputeForbidden: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (row?.status !== "connected" || row.connectedAt !== args.connectedAt) return null;
    const now = Date.now();
    if (args.disputeForbidden) {
      if (row.disputeAccess !== "forbidden") {
        await ctx.db.patch("tenantPaymentConnections", row._id, { disputeAccess: "forbidden" });
      }
      return null;
    }
    await ctx.db.patch("tenantPaymentConnections", row._id, {
      lastErrorCode: args.code,
      lastErrorAt: now,
      ...(args.code === "unauthorized" ? { status: "invalid_key" } : {}),
      ...(args.retryAfterMs === undefined ? {} : {
        nextRequestAt: Math.max(row.nextRequestAt ?? 0, now + Math.min(Math.max(0, args.retryAfterMs), MAX_RETRY_AFTER_MS)),
      }),
    });
    return null;
  },
});

export async function noteWebhook(
  ctx: MutationCtx,
  connection: Doc<"tenantPaymentConnections">,
  receivedAt: number,
) {
  await ctx.db.patch("tenantPaymentConnections", connection._id, {
    lastWebhookAt: Math.max(connection.lastWebhookAt ?? 0, receivedAt),
  });
}

export const takeSweepLease = internalMutation({
  args: {
    connectionId, token: v.string(), continuation: v.optional(v.boolean()),
    recentThrough: v.optional(v.number()),
  },
  returns: v.union(v.literal("acquired"), v.literal("busy"), v.literal("unavailable")),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (row?.status !== "connected") return "unavailable";
    const now = Date.now();
    if (args.continuation && row.sweepToken !== args.token) return "unavailable";
    if ((row.sweepUntil ?? 0) > now && row.sweepToken !== args.token) return "busy";
    await ctx.db.patch("tenantPaymentConnections", row._id, {
      sweepToken: args.token,
      sweepUntil: now + SWEEP_LEASE_MS,
      ...(args.recentThrough !== undefined && args.recentThrough > (row.sweepCreatedThrough ?? 0) &&
          row.recentSweepProgress === undefined
        ? { recentSweepProgress: { through: args.recentThrough, stage: 0, cursor: null } } : {}),
    });
    return "acquired";
  },
});

export const releaseSweepLease = internalMutation({
  args: {
    connectionId,
    token: v.string(),
    connectedAt: v.number(),
    checkpoint: v.optional(v.union(
      v.object({ kind: v.literal("recent"), through: v.number() }),
      v.object({ kind: v.literal("recent_reset") }),
      v.object({
        kind: v.literal("full"),
        startedAt: v.number(),
        cursor: v.union(v.string(), v.null()),
      }),
    )),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (row?.sweepToken !== args.token) return false;
    await ctx.db.patch("tenantPaymentConnections", row._id, {
      sweepToken: undefined,
      sweepUntil: undefined,
    });
    if (row.connectedAt !== args.connectedAt || row.status !== "connected") return false;
    const checkpoint = args.checkpoint;
    if (checkpoint?.kind === "recent") {
      await ctx.db.patch("tenantPaymentConnections", row._id, {
        sweepCreatedThrough: Math.max(row.sweepCreatedThrough ?? 0, checkpoint.through),
        lastSuccessfulSweepAt: Date.now(),
        recentSweepProgress: undefined,
      });
    } else if (checkpoint?.kind === "recent_reset") {
      await ctx.db.patch("tenantPaymentConnections", row._id, { recentSweepProgress: undefined });
    } else if (checkpoint?.kind === "full") {
      await ctx.db.patch("tenantPaymentConnections", row._id, {
        fullScanCursor: checkpoint.cursor ?? undefined,
        fullScanStartedAt: checkpoint.cursor ? checkpoint.startedAt : undefined,
        ...(checkpoint.cursor ? {} : { lastFullScanAt: Date.now() }),
      });
    }
    return true;
  },
});
