import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeAttributionTeamFromName } from "../lib/attribution/teamInput";

export type LeadGenTeamId = Id<"attributionTeams">;

type TeamCtx = QueryCtx | MutationCtx;

export type SharedDmTeam = {
  _id: Id<"attributionTeams">;
  attributionTeamId: Id<"attributionTeams">;
  name: string;
  displayName: string;
  normalizedName: string;
  utmSource: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
};

function fromAttributionTeam(team: Doc<"attributionTeams">): SharedDmTeam {
  return {
    _id: team._id,
    attributionTeamId: team._id,
    name: team.displayName,
    displayName: team.displayName,
    normalizedName: team.normalizedUtmSource,
    utmSource: team.utmSource,
    isActive: team.isActive,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

export async function getSharedDmTeam(
  ctx: TeamCtx,
  args: {
    tenantId: Id<"tenants">;
    teamId: Id<"attributionTeams">;
  },
) {
  const team = await ctx.db.get(args.teamId);
  if (!team || team.tenantId !== args.tenantId) {
    return null;
  }

  return fromAttributionTeam(team);
}

export async function listSharedDmTeams(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    includeInactive?: boolean;
  },
) {
  const rows = await ctx.db
    .query("attributionTeams")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
    .take(200);

  return rows
    .filter((team) => args.includeInactive || team.isActive)
    .map(fromAttributionTeam)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function upsertSharedDmTeamFromName(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    name: string;
    reuseActive: boolean;
  },
) {
  const normalized = normalizeAttributionTeamFromName(args.name);
  const existing = await ctx.db
    .query("attributionTeams")
    .withIndex("by_tenantId_and_normalizedUtmSource", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("normalizedUtmSource", normalized.normalizedUtmSource),
    )
    .take(5);
  const activeExisting = existing.find((team) => team.isActive);
  if (activeExisting) {
    if (args.reuseActive) {
      return activeExisting._id;
    }
    throw new Error("An active DM team with this name already exists");
  }

  const now = Date.now();
  const inactiveExisting = existing[0];
  if (inactiveExisting) {
    await ctx.db.patch(inactiveExisting._id, {
      slug: normalized.slug,
      displayName: normalized.displayName,
      utmSource: normalized.utmSource,
      normalizedUtmSource: normalized.normalizedUtmSource,
      isActive: true,
      updatedAt: now,
    });
    return inactiveExisting._id;
  }

  return await ctx.db.insert("attributionTeams", {
    tenantId: args.tenantId,
    slug: normalized.slug,
    displayName: normalized.displayName,
    utmSource: normalized.utmSource,
    normalizedUtmSource: normalized.normalizedUtmSource,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
}

export async function resolveLeadGenTeamIdForWrite(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    teamId?: Id<"attributionTeams">;
    requireActive?: boolean;
  },
) {
  if (!args.teamId) {
    return undefined;
  }

  const team = await ctx.db.get(args.teamId);
  if (
    !team ||
    team.tenantId !== args.tenantId ||
    (args.requireActive && !team.isActive)
  ) {
    throw new Error("Invalid DM team");
  }

  return team._id;
}
