import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { normalizeUtmValue, slugifyAttributionLabel } from "../lib/attribution/normalize";
import { validateRequiredString } from "../lib/validation";
import { requireTenantUser } from "../requireTenantUser";

const RESERVED_UTM_SOURCE = "ptdom";

function normalizeTeamInput(args: { displayName: string; utmSource: string }) {
  const displayName = args.displayName.trim();
  const utmSource = args.utmSource.trim();
  const displayNameValidation = validateRequiredString(displayName, {
    fieldName: "Team name",
    maxLength: 120,
  });
  if (!displayNameValidation.valid) {
    throw new Error(displayNameValidation.error);
  }
  const utmSourceValidation = validateRequiredString(utmSource, {
    fieldName: "UTM source",
    maxLength: 256,
  });
  if (!utmSourceValidation.valid) {
    throw new Error(utmSourceValidation.error);
  }
  const normalizedUtmSource = normalizeUtmValue(utmSource);
  if (!normalizedUtmSource) {
    throw new Error("UTM source is required.");
  }
  if (normalizedUtmSource === RESERVED_UTM_SOURCE) {
    throw new Error("UTM source ptdom is reserved for internal CRM links.");
  }
  const slug = slugifyAttributionLabel(displayName || utmSource);
  if (!slug) {
    throw new Error("Team name must contain at least one letter or number.");
  }
  return { displayName, utmSource, normalizedUtmSource, slug };
}

export const listTeams = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return await ctx.db
      .query("attributionTeams")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(200);
  },
});

export const createTeam = mutation({
  args: {
    displayName: v.string(),
    utmSource: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const normalized = normalizeTeamInput(args);
    const now = Date.now();

    const existingActive = await ctx.db
      .query("attributionTeams")
      .withIndex("by_tenantId_and_normalizedUtmSource", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("normalizedUtmSource", normalized.normalizedUtmSource),
      )
      .take(5);
    if (existingActive.some((team) => team.isActive)) {
      throw new Error("An active attribution team already uses this UTM source.");
    }

    return await ctx.db.insert("attributionTeams", {
      tenantId,
      slug: normalized.slug,
      displayName: normalized.displayName,
      utmSource: normalized.utmSource,
      normalizedUtmSource: normalized.normalizedUtmSource,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateTeam = mutation({
  args: {
    teamId: v.id("attributionTeams"),
    displayName: v.string(),
    utmSource: v.string(),
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
    const normalized = normalizeTeamInput(args);

    const existingActive = await ctx.db
      .query("attributionTeams")
      .withIndex("by_tenantId_and_normalizedUtmSource", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("normalizedUtmSource", normalized.normalizedUtmSource),
      )
      .take(5);
    if (
      existingActive.some(
        (candidate) => candidate.isActive && candidate._id !== args.teamId,
      )
    ) {
      throw new Error("An active attribution team already uses this UTM source.");
    }

    await ctx.db.patch(args.teamId, {
      slug: normalized.slug,
      displayName: normalized.displayName,
      utmSource: normalized.utmSource,
      normalizedUtmSource: normalized.normalizedUtmSource,
      updatedAt: Date.now(),
    });
    return args.teamId;
  },
});

export const setTeamActive = mutation({
  args: {
    teamId: v.id("attributionTeams"),
    isActive: v.boolean(),
  },
  handler: async (ctx, { teamId, isActive }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const team = await ctx.db.get(teamId);
    if (!team || team.tenantId !== tenantId) {
      throw new Error("Attribution team not found.");
    }
    await ctx.db.patch(teamId, { isActive, updatedAt: Date.now() });
    return teamId;
  },
});
