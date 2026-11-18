import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import {
  paymentConnectionErrorValidator,
  paymentProviderTables,
  providerEnvironmentValidator,
} from "./schema";

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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (row?.status !== "connected" || row.connectedAt !== args.connectedAt) return null;
    const now = Date.now();
    await ctx.db.patch("tenantPaymentConnections", row._id, {
      lastErrorCode: args.code,
      lastErrorAt: now,
      ...(args.code === "unauthorized" ? { status: "invalid_key" } : {}),
      ...(args.retryAfterMs === undefined ? {} : {
        nextRequestAt: Math.max(row.nextRequestAt ?? 0, now + args.retryAfterMs),
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
  args: { connectionId, token: v.string() },
  returns: v.union(v.literal("acquired"), v.literal("busy"), v.literal("unavailable")),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("tenantPaymentConnections", args.connectionId);
    if (row?.status !== "connected") return "unavailable";
    const now = Date.now();
    if ((row.sweepUntil ?? 0) > now && row.sweepToken !== args.token) return "busy";
    await ctx.db.patch("tenantPaymentConnections", row._id, {
      sweepToken: args.token,
      sweepUntil: now + SWEEP_LEASE_MS,
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
      });
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
