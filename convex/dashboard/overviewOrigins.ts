import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  TOP_OVERVIEW_ORIGIN_LIMIT,
} from "../leadGen/reportLimits";
import { readLeadGenOriginRowsForDashboard } from "../leadGen/reportReaders";
import type { DerivedOverviewRange } from "./overviewRange";
import type { TopOriginRow } from "./overviewTypes";

type OriginStatsRow = Doc<"leadGenOriginStats">;

function isRankableOriginKind(
  originKind: OriginStatsRow["originKind"],
): originKind is "post" | "reel" {
  return originKind === "post" || originKind === "reel";
}

function groupByOrigin(rows: OriginStatsRow[]): TopOriginRow[] {
  const byOrigin = new Map<string, TopOriginRow>();

  for (const row of rows) {
    if (!isRankableOriginKind(row.originKind)) continue;
    const key = `${row.source}:${row.originKey}`;
    const current =
      byOrigin.get(key) ??
      {
        originKey: row.originKey,
        source: row.source,
        originKind: row.originKind,
        originValue: row.originValue,
        submissions: 0,
        uniqueProspects: 0,
      };

    current.submissions += row.submissions;
    current.uniqueProspects += row.uniqueProspectsSubmitted;
    byOrigin.set(key, current);
  }

  return [...byOrigin.values()]
    .sort(
      (left, right) =>
        right.submissions - left.submissions ||
        right.uniqueProspects - left.uniqueProspects ||
        left.originValue.localeCompare(right.originValue),
    )
    .slice(0, TOP_OVERVIEW_ORIGIN_LIMIT);
}

export async function getTopOriginsOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  const rows = await readLeadGenOriginRowsForDashboard(ctx, {
    tenantId,
    startDayKey: range.startBusinessDate,
    endDayKey: range.endBusinessDateInclusive,
  });
  const origins = groupByOrigin(rows);

  return {
    data: { rows: origins },
    isEmpty: origins.length === 0,
  };
}
