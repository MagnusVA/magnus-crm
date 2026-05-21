import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { UtmParams } from "../utmParams";
import { normalizeUtmValue } from "./normalize";

type AttributionCtx = QueryCtx | MutationCtx;

export type ResolvedAttribution = {
  resolutionStatus: "mapped" | "unmapped" | "internal" | "none";
  teamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
  resolutionVersion: number;
  resolvedAt: number;
};

export const ATTRIBUTION_RESOLUTION_VERSION = 2;

export function isInternalUtm(utmParams: UtmParams | undefined) {
  return normalizeUtmValue(utmParams?.utm_source) === "ptdom";
}

export function attributionPatch(resolved: ResolvedAttribution) {
  return {
    attributionTeamId: resolved.teamId,
    dmCloserId: resolved.dmCloserId,
    attributionResolution: resolved.resolutionStatus,
    attributionResolvedAt: resolved.resolvedAt,
    attributionResolutionVersion: resolved.resolutionVersion,
  };
}

export async function resolveAttributionForTenant(
  ctx: AttributionCtx,
  args: {
    tenantId: Id<"tenants">;
    utmParams: UtmParams | undefined;
  },
): Promise<ResolvedAttribution> {
  const resolvedAt = Date.now();
  const source = normalizeUtmValue(args.utmParams?.utm_source);
  const medium = normalizeUtmValue(args.utmParams?.utm_medium);

  if (!source && !medium) {
    return {
      resolutionStatus: "none",
      resolutionVersion: ATTRIBUTION_RESOLUTION_VERSION,
      resolvedAt,
    };
  }

  if (isInternalUtm(args.utmParams)) {
    return {
      resolutionStatus: "internal",
      resolutionVersion: ATTRIBUTION_RESOLUTION_VERSION,
      resolvedAt,
    };
  }

  const team = source
    ? (
        await ctx.db
          .query("attributionTeams")
          .withIndex("by_tenantId_and_normalizedUtmSource", (q) =>
            q.eq("tenantId", args.tenantId).eq("normalizedUtmSource", source),
          )
          .take(5)
      ).find((candidate) => candidate.isActive)
    : null;

  const mediumMatches = medium
    ? (
        await ctx.db
          .query("dmClosers")
          .withIndex("by_tenantId_and_normalizedUtmMedium", (q) =>
            q.eq("tenantId", args.tenantId).eq("normalizedUtmMedium", medium),
          )
          .take(5)
      ).filter((candidate) => candidate.isActive)
    : [];

  const matchingCloser = team
    ? mediumMatches.find((candidate) => candidate.teamId === team._id)
    : mediumMatches.length === 1
      ? mediumMatches[0]
      : null;

  if (team && matchingCloser) {
    return {
      resolutionStatus: "mapped",
      teamId: team._id,
      dmCloserId: matchingCloser._id,
      resolutionVersion: ATTRIBUTION_RESOLUTION_VERSION,
      resolvedAt,
    };
  }

  if (team) {
    return {
      resolutionStatus: "mapped",
      teamId: team._id,
      resolutionVersion: ATTRIBUTION_RESOLUTION_VERSION,
      resolvedAt,
    };
  }

  if (matchingCloser) {
    return {
      resolutionStatus: "mapped",
      teamId: matchingCloser.teamId,
      dmCloserId: matchingCloser._id,
      resolutionVersion: ATTRIBUTION_RESOLUTION_VERSION,
      resolvedAt,
    };
  }

  return {
    resolutionStatus: "unmapped",
    resolutionVersion: ATTRIBUTION_RESOLUTION_VERSION,
    resolvedAt,
  };
}
