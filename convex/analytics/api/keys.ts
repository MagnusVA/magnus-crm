import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { action, internalMutation, mutation, query } from "../../_generated/server";
import { PERMISSIONS } from "../../lib/permissions";
import { expectedError, rejectRequest } from "../../lib/observability/errors";
import { log } from "../../lib/observability/log";
import { randomBase62, sha256Hex, timingSafeEqualString } from "../../lib/webCrypto";
import { requireTenantUser } from "../../requireTenantUser";
import { requireTenantUserFromAction } from "../../requireTenantUserFromAction";

// Keys for `/api/v1` (docs/plans/clickhouse-reporting.md §9.2). A key is
// `mgn_live_<keyId>_<secret>`: the key id finds the row, and only the SHA-256
// of the 32-byte random secret is stored, so a leaked table can't call the API.

export const API_KEY_PREFIX = "mgn_live_";
const KEY_ID_BYTES = 9;
const SECRET_BYTES = 32;
const MAX_ACTIVE_KEYS = 10;
/** Keys a workspace may ever create, revoked included; bounds every scan. */
const MAX_KEYS = 500;
const LISTED_REVOKED_KEYS = 20;
const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT_PER_MINUTE = 60;

const keyRowValidator = v.object({
  keyId: v.string(),
  name: v.string(),
  prefix: v.string(),
  createdAt: v.number(),
  createdByName: v.union(v.string(), v.null()),
  lastUsedAt: v.union(v.number(), v.null()),
  revokedAt: v.union(v.number(), v.null()),
});

export const list = query({
  args: {},
  returns: v.array(keyRowValidator),
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["settings:manage"]]);
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(MAX_KEYS);
    // Every active key, then the newest revoked ones.
    const shown = [
      ...keys.filter((key) => key.revokedAt === undefined),
      ...keys.filter((key) => key.revokedAt !== undefined).slice(0, LISTED_REVOKED_KEYS),
    ];
    return await Promise.all(
      shown.map(async (key) => {
        const creator = await ctx.db.get("users", key.createdByUserId);
        return {
          keyId: key.keyId,
          name: key.name,
          prefix: `${API_KEY_PREFIX}${key.keyId}_…`,
          createdAt: key.createdAt,
          createdByName: creator?.fullName ?? null,
          lastUsedAt: key.lastUsedAt ?? null,
          revokedAt: key.revokedAt ?? null,
        };
      }),
    );
  },
});

export const insertKey = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    userId: v.id("users"),
    keyId: v.string(),
    secretHash: v.string(),
    name: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .take(MAX_KEYS);
    if (keys.length >= MAX_KEYS) {
      throw expectedError("api_keys.limit", "This workspace has created too many API keys.");
    }
    if (keys.filter((key) => key.revokedAt === undefined).length >= MAX_ACTIVE_KEYS) {
      throw expectedError("api_keys.limit", `Revoke a key first: a workspace can have ${MAX_ACTIVE_KEYS} active keys.`);
    }
    await ctx.db.insert("apiKeys", {
      tenantId: args.tenantId,
      keyId: args.keyId,
      secretHash: args.secretHash,
      name: args.name,
      scopes: ["metrics:read"],
      createdByUserId: args.userId,
      createdAt: Date.now(),
    });
    log.info("api_keys.created", { tenantId: args.tenantId, keyId: args.keyId });
    return null;
  },
});

/**
 * Creates a key and returns it once. An action, so the secret comes from the
 * platform's random source rather than a mutation's seeded one.
 */
export const create = action({
  args: { name: v.string() },
  returns: v.object({ key: v.string(), keyId: v.string() }),
  handler: async (ctx, { name }) => {
    const { tenantId, userId } = await requireTenantUserFromAction(ctx, [...PERMISSIONS["settings:manage"]]);
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 60) {
      throw rejectRequest("api_keys.invalid_name", "Name the key in 1 to 60 characters.");
    }
    const keyId = randomBase62(KEY_ID_BYTES);
    const secret = randomBase62(SECRET_BYTES);
    await ctx.runMutation(internal.analytics.api.keys.insertKey, {
      tenantId,
      userId,
      keyId,
      secretHash: await sha256Hex(secret),
      name: trimmed,
    });
    return { key: `${API_KEY_PREFIX}${keyId}_${secret}`, keyId };
  },
});

export const revoke = mutation({
  args: { keyId: v.string() },
  returns: v.null(),
  handler: async (ctx, { keyId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["settings:manage"]]);
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_keyId", (q) => q.eq("keyId", keyId))
      .unique();
    if (!key || key.tenantId !== tenantId) {
      throw rejectRequest("api_keys.not_found", "Key not found.");
    }
    if (key.revokedAt === undefined) {
      await ctx.db.patch("apiKeys", key._id, { revokedAt: Date.now(), revokedByUserId: userId });
      log.info("api_keys.revoked", { tenantId, keyId });
    }
    return null;
  },
});

/** Splits `mgn_live_<keyId>_<secret>`; null for anything else. */
export function parseApiKey(raw: string): { keyId: string; secret: string } | null {
  if (!raw.startsWith(API_KEY_PREFIX)) return null;
  const [keyId, secret, extra] = raw.slice(API_KEY_PREFIX.length).split("_");
  if (!keyId || !secret || extra !== undefined) return null;
  if (!/^[0-9A-Za-z]+$/.test(keyId) || !/^[0-9A-Za-z]+$/.test(secret)) return null;
  return { keyId, secret };
}

/**
 * Checks a key and counts the request against its 60 a minute, on the key's
 * own row. The tenant always comes from the key.
 */
export const authenticate = internalMutation({
  args: { keyId: v.string(), secretHash: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), tenantId: v.id("tenants"), keyId: v.string() }),
    v.object({ ok: v.literal(false), status: v.union(v.literal(401), v.literal(429)), retryAfterSeconds: v.number() }),
  ),
  handler: async (ctx, { keyId, secretHash }) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_keyId", (q) => q.eq("keyId", keyId))
      .unique();
    // Compare even when there's no row, so a missing key takes as long as a wrong one.
    const matches = timingSafeEqualString(key?.secretHash ?? "0".repeat(64), secretHash);
    if (!key || !matches || key.revokedAt !== undefined || !key.scopes.includes("metrics:read")) {
      return { ok: false as const, status: 401 as const, retryAfterSeconds: 0 };
    }
    const now = Date.now();
    const windowStart = key.rateWindowStartedAt ?? 0;
    const inWindow = now - windowStart < RATE_WINDOW_MS;
    const count = inWindow ? (key.rateWindowCount ?? 0) + 1 : 1;
    if (count > RATE_LIMIT_PER_MINUTE) {
      return {
        ok: false as const,
        status: 429 as const,
        retryAfterSeconds: Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000)),
      };
    }
    await ctx.db.patch("apiKeys", key._id, {
      lastUsedAt: now,
      rateWindowStartedAt: inWindow ? windowStart : now,
      rateWindowCount: count,
    });
    return { ok: true as const, tenantId: key.tenantId, keyId: key.keyId };
  },
});
