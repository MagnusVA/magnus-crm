import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import { normalizeUtmValue, slugifyAttributionLabel } from "../lib/attribution/normalize";
import { dmCloserMemberIdentity } from "../lib/memberIdentity";
import { validateRequiredString } from "../lib/validation";
import { requireTenantUser } from "../requireTenantUser";

function normalizeDmCloserInput(args: {
  displayName: string;
  utmMedium: string;
}) {
  const displayName = args.displayName.trim();
  const utmMedium = args.utmMedium.trim();
  const displayNameValidation = validateRequiredString(displayName, {
    fieldName: "DM closer name",
    maxLength: 120,
  });
  if (!displayNameValidation.valid) {
    throw new Error(displayNameValidation.error);
  }
  const utmMediumValidation = validateRequiredString(utmMedium, {
    fieldName: "UTM medium",
    maxLength: 256,
  });
  if (!utmMediumValidation.valid) {
    throw new Error(utmMediumValidation.error);
  }
  const normalizedUtmMedium = normalizeUtmValue(utmMedium);
  if (!normalizedUtmMedium) {
    throw new Error("UTM medium is required.");
  }
  const slug = slugifyAttributionLabel(displayName || utmMedium);
  if (!slug) {
    throw new Error("DM closer name must contain at least one letter or number.");
  }
  return { displayName, utmMedium, normalizedUtmMedium, slug };
}

async function getLinkedUserForWrite(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  userId: Id<"users"> | null | undefined,
) {
  if (!userId) return null;

  const user = await ctx.db.get(userId);
  if (!user || user.tenantId !== tenantId) {
    throw new Error("Linked user not found.");
  }

  return user;
}

export const listDmClosers = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const closers = await ctx.db
      .query("dmClosers")
      .withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", tenantId))
      .take(300);
    const teams = await ctx.db
      .query("attributionTeams")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(200);
    const teamById = new Map(teams.map((team) => [team._id, team]));
    const linkedUserIds = [
      ...new Set(
        closers
          .map((closer) => closer.userId)
          .filter((userId): userId is Id<"users"> => Boolean(userId)),
      ),
    ];
    const linkedUsers = await Promise.all(
      linkedUserIds.map((userId) => ctx.db.get(userId)),
    );
    const linkedUserById = new Map(
      linkedUsers
        .filter(
          (user): user is Doc<"users"> =>
            user !== null && user.tenantId === tenantId,
        )
        .map((user) => [user._id, user]),
    );

    return await Promise.all(
      closers.map(async (closer) => {
        const linkedUser = closer.userId
          ? linkedUserById.get(closer.userId) ?? null
          : null;

        return {
          ...closer,
          teamLabel: teamById.get(closer.teamId)?.displayName ?? "Unknown team",
          identity: await dmCloserMemberIdentity(ctx, closer, linkedUser),
        };
      }),
    );
  },
});

export const createDmCloser = mutation({
  args: {
    teamId: v.id("attributionTeams"),
    displayName: v.string(),
    utmMedium: v.string(),
    userId: v.optional(v.union(v.id("users"), v.null())),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const team = await ctx.db.get(args.teamId);
    if (!team || team.tenantId !== tenantId) {
      throw new Error("Attribution team not found.");
    }
    const linkedUser = await getLinkedUserForWrite(
      ctx,
      tenantId,
      args.userId,
    );
    const normalized = normalizeDmCloserInput(args);
    const now = Date.now();

    const existingActive = await ctx.db
      .query("dmClosers")
      .withIndex("by_tenantId_and_normalizedUtmMedium", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("normalizedUtmMedium", normalized.normalizedUtmMedium),
      )
      .take(5);
    if (existingActive.some((closer) => closer.isActive)) {
      throw new Error("An active DM closer already uses this UTM medium.");
    }

    return await ctx.db.insert("dmClosers", {
      tenantId,
      teamId: args.teamId,
      slug: normalized.slug,
      displayName: normalized.displayName,
      utmMedium: normalized.utmMedium,
      normalizedUtmMedium: normalized.normalizedUtmMedium,
      userId: linkedUser?._id,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateDmCloser = mutation({
  args: {
    dmCloserId: v.id("dmClosers"),
    teamId: v.id("attributionTeams"),
    displayName: v.string(),
    utmMedium: v.string(),
    userId: v.optional(v.union(v.id("users"), v.null())),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const dmCloser = await ctx.db.get(args.dmCloserId);
    if (!dmCloser || dmCloser.tenantId !== tenantId) {
      throw new Error("DM closer not found.");
    }
    const team = await ctx.db.get(args.teamId);
    if (!team || team.tenantId !== tenantId) {
      throw new Error("Attribution team not found.");
    }
    const shouldPatchUserId = Object.hasOwn(args, "userId");
    const linkedUser = await getLinkedUserForWrite(
      ctx,
      tenantId,
      shouldPatchUserId ? args.userId : dmCloser.userId,
    );
    const normalized = normalizeDmCloserInput(args);
    const existingActive = await ctx.db
      .query("dmClosers")
      .withIndex("by_tenantId_and_normalizedUtmMedium", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("normalizedUtmMedium", normalized.normalizedUtmMedium),
      )
      .take(5);
    if (
      existingActive.some(
        (candidate) => candidate.isActive && candidate._id !== args.dmCloserId,
      )
    ) {
      throw new Error("An active DM closer already uses this UTM medium.");
    }

    await ctx.db.patch(args.dmCloserId, {
      teamId: args.teamId,
      slug: normalized.slug,
      displayName: normalized.displayName,
      utmMedium: normalized.utmMedium,
      normalizedUtmMedium: normalized.normalizedUtmMedium,
      userId: linkedUser?._id,
      updatedAt: Date.now(),
    });
    return args.dmCloserId;
  },
});

// NIM-17: cap for the per-DM-closer hourly contract rate in minor units
// (10,000,000 minor units = 100,000.00 in major units per hour).
const MAX_HOURLY_RATE_MINOR = 10_000_000;

// NIM-17: set or clear a DM closer's hourly contract rate in minor currency
// units (e.g. cents). Pass null to clear the rate.
export const setDmCloserHourlyRate = mutation({
  args: {
    dmCloserId: v.id("dmClosers"),
    hourlyRateMinor: v.union(v.number(), v.null()),
  },
  returns: v.id("dmClosers"),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const dmCloser = await ctx.db.get(args.dmCloserId);
    if (!dmCloser || dmCloser.tenantId !== tenantId) {
      throw new Error("DM closer not found.");
    }

    if (
      args.hourlyRateMinor !== null &&
      (!Number.isInteger(args.hourlyRateMinor) ||
        args.hourlyRateMinor < 0 ||
        args.hourlyRateMinor > MAX_HOURLY_RATE_MINOR)
    ) {
      throw new Error(
        `Hourly rate must be an integer between 0 and ${MAX_HOURLY_RATE_MINOR} minor units.`,
      );
    }

    await ctx.db.patch(args.dmCloserId, {
      hourlyRateMinor: args.hourlyRateMinor ?? undefined,
      updatedAt: Date.now(),
    });
    return args.dmCloserId;
  },
});

export const setDmCloserActive = mutation({
  args: {
    dmCloserId: v.id("dmClosers"),
    isActive: v.boolean(),
  },
  handler: async (ctx, { dmCloserId, isActive }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const dmCloser = await ctx.db.get(dmCloserId);
    if (!dmCloser || dmCloser.tenantId !== tenantId) {
      throw new Error("DM closer not found.");
    }
    await ctx.db.patch(dmCloserId, { isActive, updatedAt: Date.now() });
    return dmCloserId;
  },
});
