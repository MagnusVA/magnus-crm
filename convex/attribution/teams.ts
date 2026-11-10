import { expectedError } from "../lib/observability/errors";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import { normalizeAttributionTeamInput } from "../lib/attribution/teamInput";
import { log } from "../lib/observability/log";
import {
  assertCoreRole,
  provenanceMetadata,
  WEB,
  type CoreActor,
  type Provenance,
} from "../lib/outcomeCores";
import { requireTenantUser } from "../requireTenantUser";

// Matches MAX_DAILY_TEAM_GOAL in reporting/slackQualifications.ts.
const MAX_BOOKING_DAILY_QUOTA = 5000;

// Every row sharing one normalised UTM value. The range is tiny (one value),
// and the uniqueness checks must see all of it: an active row can sit behind
// any number of disabled ones.
async function allWithUtmSource<T>(query: AsyncIterable<T>): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of query) rows.push(row);
  return rows;
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
    const normalized = normalizeAttributionTeamInput(args);
    const now = Date.now();

    const existingActive = await allWithUtmSource(ctx.db
      .query("attributionTeams")
      .withIndex("by_tenantId_and_normalizedUtmSource", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("normalizedUtmSource", normalized.normalizedUtmSource),
      ));
    if (existingActive.some((team) => team.isActive)) {
      throw expectedError("attribution.rejected", "An active attribution team already uses this UTM source.");
    }

    const teamId = await ctx.db.insert("attributionTeams", {
      tenantId,
      slug: normalized.slug,
      displayName: normalized.displayName,
      utmSource: normalized.utmSource,
      normalizedUtmSource: normalized.normalizedUtmSource,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    log.info("attribution.team.created", { tenantId, teamId });
    return teamId;
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
    const team = await ctx.db.get("attributionTeams", args.teamId);
    if (!team || team.tenantId !== tenantId) {
      throw expectedError("attribution.rejected", "Attribution team not found.");
    }
    const normalized = normalizeAttributionTeamInput(args);

    const existingActive = await allWithUtmSource(ctx.db
      .query("attributionTeams")
      .withIndex("by_tenantId_and_normalizedUtmSource", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("normalizedUtmSource", normalized.normalizedUtmSource),
      ));
    if (
      existingActive.some(
        (candidate) => candidate.isActive && candidate._id !== args.teamId,
      )
    ) {
      throw expectedError("attribution.rejected", "An active attribution team already uses this UTM source.");
    }

    await ctx.db.patch("attributionTeams", args.teamId, {
      slug: normalized.slug,
      displayName: normalized.displayName,
      utmSource: normalized.utmSource,
      normalizedUtmSource: normalized.normalizedUtmSource,
      updatedAt: Date.now(),
    });
    log.info("attribution.team.updated", {
      tenantId,
      teamId: args.teamId,
      utmSourceChanged:
        team.normalizedUtmSource !== normalized.normalizedUtmSource,
    });
    return args.teamId;
  },
});

export type SetTeamBookingQuotaArgs = {
  teamId: Id<"attributionTeams">;
  bookingDailyQuota: number | null;
};

/**
 * Sets or clears a team's daily booked-calls goal: the core of
 * `setTeamBookingQuota`. No event covers a goal; the change is logged with
 * its provenance.
 */
export async function setTeamBookingQuotaCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: SetTeamBookingQuotaArgs,
  provenance: Provenance,
): Promise<Id<"attributionTeams">> {
  assertCoreRole(actor, ["tenant_master", "tenant_admin"]);
  const { tenantId } = actor;
  const team = await ctx.db.get("attributionTeams", args.teamId);
  if (!team || team.tenantId !== tenantId) {
    throw expectedError("attribution.rejected", "Attribution team not found.");
  }

  if (
    args.bookingDailyQuota !== null &&
    (!Number.isInteger(args.bookingDailyQuota) ||
      args.bookingDailyQuota < 0 ||
      args.bookingDailyQuota > MAX_BOOKING_DAILY_QUOTA)
  ) {
    throw expectedError("attribution.rejected", 
      `Daily booking goal must be an integer between 0 and ${MAX_BOOKING_DAILY_QUOTA}.`,
    );
  }

  await ctx.db.patch("attributionTeams", args.teamId, {
    bookingDailyQuota: args.bookingDailyQuota ?? undefined,
    updatedAt: Date.now(),
  });
  log.info("attribution.team_booking_quota.set", {
    tenantId,
    actorUserId: actor.userId,
    teamId: args.teamId,
    bookingDailyQuota: args.bookingDailyQuota,
    via: provenance.via,
    ...provenanceMetadata(provenance),
  });
  return args.teamId;
}

// NIM-17: set or clear the per-team daily booked-calls goal shown on the
// Booked Calls page. Pass null to clear the goal.
export const setTeamBookingQuota = mutation({
  args: {
    teamId: v.id("attributionTeams"),
    bookingDailyQuota: v.union(v.number(), v.null()),
  },
  returns: v.id("attributionTeams"),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    return await setTeamBookingQuotaCore(ctx, actor, args, WEB);
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
    const team = await ctx.db.get("attributionTeams", teamId);
    if (!team || team.tenantId !== tenantId) {
      throw expectedError("attribution.rejected", "Attribution team not found.");
    }
    if (isActive && !team.isActive) {
      const sameSource = await allWithUtmSource(ctx.db
        .query("attributionTeams")
        .withIndex("by_tenantId_and_normalizedUtmSource", (q) =>
          q.eq("tenantId", tenantId).eq("normalizedUtmSource", team.normalizedUtmSource),
        ));
      if (sameSource.some((candidate) => candidate._id !== teamId && candidate.isActive)) {
        throw expectedError("attribution.rejected", "An active attribution team already uses this UTM source.");
      }
    }
    await ctx.db.patch("attributionTeams", teamId, { isActive, updatedAt: Date.now() });
    log.info("attribution.team.active_set", {
      tenantId,
      teamId,
      isActive,
      changed: team.isActive !== isActive,
    });
    return teamId;
  },
});
