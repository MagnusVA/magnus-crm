import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  TOP_OVERVIEW_ORIGINS_PER_TEAM,
} from "../leadGen/reportLimits";
import {
  loadLeadGenTeamsForRows,
  readLeadGenTeamOriginRowsForDashboard,
} from "../leadGen/reportReaders";
import type { LeadGenTeamId } from "../leadGen/sharedTeams";
import type { DerivedOverviewRange } from "./overviewRange";
import type { TopOriginRow, TopOriginsByTeamRow } from "./overviewTypes";

type TeamOriginStatsRow = Doc<"leadGenTeamOriginStats">;

function isRankableOriginKind(
  originKind: TeamOriginStatsRow["originKind"],
): originKind is "post" | "reel" {
  return originKind === "post" || originKind === "reel";
}

function compareTopOriginRows(
  left: TopOriginRow,
  right: TopOriginRow,
) {
  if (left.uniqueProspects !== right.uniqueProspects) {
    return right.uniqueProspects - left.uniqueProspects;
  }
  return left.originValue.localeCompare(right.originValue);
}

function groupByTeam(
  rows: TeamOriginStatsRow[],
  limitPerTeam: number,
): Array<{
  teamId: LeadGenTeamId | null;
  totalUniqueProspects: number;
  origins: TopOriginRow[];
}> {
  const byTeam = new Map<
    string,
    {
      teamId: LeadGenTeamId | null;
      totalUniqueProspects: number;
      origins: Map<string, TopOriginRow>;
    }
  >();

  for (const row of rows) {
    if (!isRankableOriginKind(row.originKind)) continue;

    const teamKey = row.teamId ?? "unassigned";
    const currentTeam =
      byTeam.get(teamKey) ??
      {
        teamId: row.teamId ?? null,
        totalUniqueProspects: 0,
        origins: new Map(),
      };

    const originMapKey = `${row.source}:${row.originKey}`;
    const currentOrigin =
      currentTeam.origins.get(originMapKey) ??
      {
        originKey: row.originKey,
        source: row.source,
        originKind: row.originKind,
        originValue: row.originValue,
        uniqueProspects: 0,
      };

    currentOrigin.uniqueProspects += row.uniqueProspectsSubmitted;
    currentTeam.totalUniqueProspects += row.uniqueProspectsSubmitted;
    currentTeam.origins.set(originMapKey, currentOrigin);
    byTeam.set(teamKey, currentTeam);
  }

  return [...byTeam.values()].map((team) => ({
    teamId: team.teamId,
    totalUniqueProspects: team.totalUniqueProspects,
    origins: [...team.origins.values()]
      .sort(compareTopOriginRows)
      .slice(0, limitPerTeam),
  }));
}

export async function getTopOriginsOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  const rows = await readLeadGenTeamOriginRowsForDashboard(ctx, {
    tenantId,
    startDayKey: range.startBusinessDate,
    endDayKey: range.endBusinessDateInclusive,
  });
  const groupedTeams = groupByTeam(rows, TOP_OVERVIEW_ORIGINS_PER_TEAM);
  const teams = await loadLeadGenTeamsForRows(
    ctx,
    tenantId,
    groupedTeams.map((team) => ({ teamId: team.teamId ?? undefined })),
  );

  const teamRows: TopOriginsByTeamRow[] = groupedTeams
    .map((team) => {
      const teamDoc = team.teamId ? teams.get(team.teamId) : null;
      return {
        teamId: team.teamId,
        teamName: teamDoc?.name ?? "Unassigned",
        isActive: teamDoc?.isActive ?? (team.teamId ? false : null),
        totalUniqueProspects: team.totalUniqueProspects,
        origins: team.origins,
      };
    })
    .sort((left, right) => {
      if (left.totalUniqueProspects !== right.totalUniqueProspects) {
        return right.totalUniqueProspects - left.totalUniqueProspects;
      }
      return left.teamName.localeCompare(right.teamName);
    });

  return {
    data: { rows: teamRows },
    isEmpty: teamRows.length === 0,
  };
}
