import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const GENERIC_PORTAL_AUTH_ERROR = "Portal unavailable or password invalid.";

export const assertNotLocked = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    ipHash: v.string(),
  },
  handler: async (ctx, { tenantId, ipHash }) => {
    const attempt = await ctx.db
      .query("linkPortalAuthAttempts")
      .withIndex("by_tenantId_and_ipHash", (q) =>
        q.eq("tenantId", tenantId).eq("ipHash", ipHash),
      )
      .unique();

    if (attempt?.lockedUntil && attempt.lockedUntil > Date.now()) {
      throw new Error(GENERIC_PORTAL_AUTH_ERROR);
    }
  },
});

export const recordFailedAttempt = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    ipHash: v.string(),
  },
  handler: async (ctx, { tenantId, publicSlug, ipHash }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("linkPortalAuthAttempts")
      .withIndex("by_tenantId_and_ipHash", (q) =>
        q.eq("tenantId", tenantId).eq("ipHash", ipHash),
      )
      .unique();

    const inWindow = existing ? now - existing.windowStartedAt < WINDOW_MS : false;
    const failedCount = inWindow && existing ? existing.failedCount + 1 : 1;
    const lockedUntil = failedCount >= MAX_FAILURES ? now + LOCK_MS : undefined;

    if (!existing) {
      await ctx.db.insert("linkPortalAuthAttempts", {
        tenantId,
        publicSlug,
        ipHash,
        failedCount,
        windowStartedAt: now,
        lockedUntil,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.patch(existing._id, {
      publicSlug,
      failedCount,
      windowStartedAt: inWindow ? existing.windowStartedAt : now,
      lockedUntil,
      updatedAt: now,
    });
  },
});

export const clearFailedAttempts = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    ipHash: v.string(),
  },
  handler: async (ctx, { tenantId, ipHash }) => {
    const existing = await ctx.db
      .query("linkPortalAuthAttempts")
      .withIndex("by_tenantId_and_ipHash", (q) =>
        q.eq("tenantId", tenantId).eq("ipHash", ipHash),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});
