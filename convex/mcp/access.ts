import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery } from "../_generated/server";
import { gateway } from "./gateway";
import { mcpCallerValidator, resolveMcpAccess, writeFamiliesFor } from "./guard";

const SESSION_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // decision 16
const PRUNE_BATCH = 200;

export const callerAccessValidator = v.union(
  v.object({
    ok: v.literal(true),
    userId: v.id("users"),
    role: v.string(),
    fullName: v.string(),
    companyName: v.string(),
    timeZone: v.string(),
    // Admin assistants only: the kinds of change switched on for this role.
    writeFamilies: v.array(v.string()),
  }),
  v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
);

/**
 * The gateway's `authorize` callback runs in the HTTP action, which has no
 * database, so it asks this query once per request. The same checks run again
 * inside every tool through `requireMcpUser`.
 */
export const checkCaller = internalQuery({
  args: { caller: mcpCallerValidator },
  returns: callerAccessValidator,
  handler: async (ctx, { caller }) => {
    const access = await resolveMcpAccess(ctx, caller);
    if (!access.ok) return { ok: false as const, ...access.denial };
    const { user, tenant } = access;
    return {
      ok: true as const,
      userId: user._id,
      role: user.role,
      fullName: user.fullName ?? user.email,
      companyName: tenant.companyName,
      timeZone: user.timezone ?? tenant.businessDay?.timeZone ?? "America/Tegucigalpa",
      writeFamilies: writeFamiliesFor(user, tenant),
    };
  },
});

export const getClientSession = internalQuery({
  args: { sessionId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { sessionId }) => {
    const row = await ctx.db
      .query("mcpClientSessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .first();
    return row?.clientName ?? null;
  },
});

export const recordClientSession = internalMutation({
  args: {
    sessionId: v.string(),
    clientName: v.string(),
    clientVersion: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("mcpClientSessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .first();
    if (existing) return null;
    await ctx.db.insert("mcpClientSessions", {
      sessionId: args.sessionId,
      clientName: args.clientName.slice(0, 80),
      ...(args.clientVersion ? { clientVersion: args.clientVersion.slice(0, 40) } : {}),
      createdAt: Date.now(),
    });
    return null;
  },
});

/**
 * Daily upkeep: idle gateway sessions after 30 days, audit rows after 90
 * (decision 16), our client-name rows after 30, preview tokens an hour after
 * they expire, and admin receipts once their year is up
 * (docs/plans/admin-assistant.md §4). Each pass reads only rows it deletes, so
 * kept receipts never fill a batch, and a full pass reschedules itself.
 */
export const pruneDaily = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const sessions = await gateway.pruneSessions(ctx, SESSION_CLIENT_TTL_MS);
    const audit = await gateway.pruneAuditEntries(ctx, AUDIT_RETENTION_MS);

    const now = Date.now();
    const clientRows = await ctx.db
      .query("mcpClientSessions")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", now - SESSION_CLIENT_TTL_MS))
      .take(PRUNE_BATCH);
    for (const row of clientRows) await ctx.db.delete("mcpClientSessions", row._id);

    // Tokens kept as no receipt: expired over an hour ago.
    const tokens = await ctx.db
      .query("mcpConfirmations")
      .withIndex("by_keepUntil_and_expiresAt", (q) =>
        q.eq("keepUntil", undefined).lt("expiresAt", now - 60 * 60 * 1000),
      )
      .take(PRUNE_BATCH);
    for (const row of tokens) await ctx.db.delete("mcpConfirmations", row._id);

    // Receipts whose year is up. The lower bound skips rows with no keepUntil,
    // which sort first in the index.
    const receipts = await ctx.db
      .query("mcpConfirmations")
      .withIndex("by_keepUntil_and_expiresAt", (q) =>
        q.gt("keepUntil", 0).lt("keepUntil", now),
      )
      .take(PRUNE_BATCH);
    for (const row of receipts) await ctx.db.delete("mcpConfirmations", row._id);

    const reports = await ctx.db
      .query("mcpReportRequests")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(PRUNE_BATCH);
    let deletions = 0;
    for (const row of reports) {
      await ctx.db.delete("mcpReportRequests", row._id);
      // Answer parts go in their own small batches, never in this mutation,
      // and staggered a second apart so expiring answers don't burst writes.
      for (const runToken of new Set([row.runToken, row.payloadRunToken]))
        if (runToken !== undefined)
          await ctx.scheduler.runAfter(
            1_000 * deletions++,
            internal.mcp.reports.admission.deleteParts,
            { requestId: row._id, runToken },
          );
    }

    if (
      sessions >= PRUNE_BATCH ||
      audit >= PRUNE_BATCH ||
      clientRows.length === PRUNE_BATCH ||
      tokens.length === PRUNE_BATCH ||
      receipts.length === PRUNE_BATCH ||
      reports.length === PRUNE_BATCH
    ) {
      await ctx.scheduler.runAfter(0, internal.mcp.access.pruneDaily, {});
    }
    return null;
  },
});
