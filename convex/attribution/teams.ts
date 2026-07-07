import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { normalizeAttributionTeamInput } from "../lib/attribution/teamInput";
import { requireTenantUser } from "../requireTenantUser";

// Matches MAX_DAILY_TEAM_GOAL in reporting/slackQualifications.ts.
const MAX_BOOKING_DAILY_QUOTA = 5000;

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
    const normalized = normalizeAttributionTeamInput(args);
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
    const normalized = normalizeAttributionTeamInput(args);

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

// NIM-17: set or clear the per-team daily booked-calls goal shown on the
// Booked Calls page. Pass null to clear the goal.
export const setTeamBookingQuota = mutation({
  args: {
    teamId: v.id("attributionTeams"),
    bookingDailyQuota: v.union(v.number(), v.null()),
  },
  returns: v.id("attributionTeams"),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const team = await ctx.db.get(args.teamId);
    if (!team || team.tenantId !== tenantId) {
      throw new Error("Attribution team not found.");
    }

    if (
      args.bookingDailyQuota !== null &&
      (!Number.isInteger(args.bookingDailyQuota) ||
        args.bookingDailyQuota < 0 ||
        args.bookingDailyQuota > MAX_BOOKING_DAILY_QUOTA)
    ) {
      throw new Error(
        `Daily booking goal must be an integer between 0 and ${MAX_BOOKING_DAILY_QUOTA}.`,
      );
    }

    await ctx.db.patch(args.teamId, {
      bookingDailyQuota: args.bookingDailyQuota ?? undefined,
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
