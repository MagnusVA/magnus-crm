import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { buildQualifierEfficiencyRows } from "./overviewLeaderboardBuilders";
import type { DerivedOverviewRange } from "./overviewRange";

export async function getTopQualifiersOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  const { rows, truncated } = await buildQualifierEfficiencyRows(ctx, {
    tenantId,
    range,
    includeAllCandidates: false,
  });

  return {
    data: {
      totalQualified: rows.reduce(
        (sum, row) => sum + row.uniqueOpportunityCount,
        0,
      ),
      rows: rows.slice(0, 5),
    },
    truncated,
    isEmpty: rows.length === 0,
  };
}
