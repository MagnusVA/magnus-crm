import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, mutation } from "../_generated/server";
import { portalPasswordHashParamsValidator } from "../lib/linkPortal/validators";
import { requireTenantUser } from "../requireTenantUser";

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 15 * 60;
const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60;

function normalizeTtl(ttlSeconds: number) {
  const normalized = Math.floor(ttlSeconds);
  if (
    !Number.isFinite(normalized) ||
    normalized < MIN_SESSION_TTL_SECONDS ||
    normalized > MAX_SESSION_TTL_SECONDS
  ) {
    throw new Error("Session duration must be between 15 minutes and 24 hours.");
  }
  return normalized;
}

async function getConfigByTenant(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
) {
  return await ctx.db
    .query("linkPortalConfigs")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .unique();
}

async function assertPublicSlugAvailable(
  ctx: MutationCtx,
  publicSlug: string,
  tenantId: Id<"tenants">,
) {
  const existing = await ctx.db
    .query("linkPortalConfigs")
    .withIndex("by_publicSlug", (q) => q.eq("publicSlug", publicSlug))
    .unique();

  if (existing && existing.tenantId !== tenantId) {
    throw new Error("Portal slug collision.");
  }
}

export const ensureConfigForTenant = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
  },
  handler: async (ctx, { tenantId, publicSlug }) => {
    const existing = await getConfigByTenant(ctx, tenantId);
    if (existing) {
      return existing;
    }

    await assertPublicSlugAvailable(ctx, publicSlug, tenantId);

    const now = Date.now();
    const configId = await ctx.db.insert("linkPortalConfigs", {
      tenantId,
      publicSlug,
      isEnabled: false,
      sessionVersion: 1,
      sessionTtlSeconds: DEFAULT_SESSION_TTL_SECONDS,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(configId);
  },
});

export const rotatePasswordHash = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    passwordHash: v.string(),
    passwordSalt: v.string(),
    passwordHashParams: portalPasswordHashParamsValidator,
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const config = await getConfigByTenant(ctx, args.tenantId);

    if (!config) {
      await assertPublicSlugAvailable(ctx, args.publicSlug, args.tenantId);

      const configId = await ctx.db.insert("linkPortalConfigs", {
        tenantId: args.tenantId,
        publicSlug: args.publicSlug,
        isEnabled: false,
        passwordHash: args.passwordHash,
        passwordSalt: args.passwordSalt,
        passwordHashParams: args.passwordHashParams,
        passwordSetAt: now,
        passwordRotatedAt: now,
        sessionVersion: 1,
        sessionTtlSeconds: DEFAULT_SESSION_TTL_SECONDS,
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.get(configId);
    }

    await ctx.db.patch(config._id, {
      passwordHash: args.passwordHash,
      passwordSalt: args.passwordSalt,
      passwordHashParams: args.passwordHashParams,
      passwordSetAt: config.passwordSetAt ?? now,
      passwordRotatedAt: now,
      sessionVersion: config.sessionVersion + 1,
      updatedAt: now,
    });
    return await ctx.db.get(config._id);
  },
});

export const rotatePublicSlug = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
  },
  handler: async (ctx, { tenantId, publicSlug }) => {
    await assertPublicSlugAvailable(ctx, publicSlug, tenantId);

    const config = await getConfigByTenant(ctx, tenantId);
    if (!config) {
      throw new Error("Set a portal password first.");
    }

    await ctx.db.patch(config._id, {
      publicSlug,
      sessionVersion: config.sessionVersion + 1,
      updatedAt: Date.now(),
    });
    return {
      portalUrlPath: `/dm-links/${publicSlug}`,
      publicSlug,
      sessionVersion: config.sessionVersion + 1,
    };
  },
});

export const setPortalEnabled = mutation({
  args: { isEnabled: v.boolean() },
  handler: async (ctx, { isEnabled }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const config = await getConfigByTenant(ctx, tenantId);
    if (!config) {
      throw new Error("Set a portal password first.");
    }
    if (isEnabled && (!config.passwordHash || !config.passwordSalt)) {
      throw new Error("Set a portal password before enabling the portal.");
    }
    if (config.isEnabled === isEnabled) {
      return {
        isEnabled: config.isEnabled,
        sessionVersion: config.sessionVersion,
      };
    }

    const sessionVersion = isEnabled
      ? config.sessionVersion
      : config.sessionVersion + 1;
    await ctx.db.patch(config._id, {
      isEnabled,
      sessionVersion,
      updatedAt: Date.now(),
    });
    return { isEnabled, sessionVersion };
  },
});

export const updateSessionTtl = mutation({
  args: { sessionTtlSeconds: v.number() },
  handler: async (ctx, { sessionTtlSeconds }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const config = await getConfigByTenant(ctx, tenantId);
    if (!config) {
      throw new Error("Set a portal password first.");
    }

    const normalizedTtl = normalizeTtl(sessionTtlSeconds);
    if (config.sessionTtlSeconds === normalizedTtl) {
      return {
        sessionTtlSeconds: normalizedTtl,
        sessionVersion: config.sessionVersion,
      };
    }

    await ctx.db.patch(config._id, {
      sessionTtlSeconds: normalizedTtl,
      sessionVersion: config.sessionVersion + 1,
      updatedAt: Date.now(),
    });
    return {
      sessionTtlSeconds: normalizedTtl,
      sessionVersion: config.sessionVersion + 1,
    };
  },
});
