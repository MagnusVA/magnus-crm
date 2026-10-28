import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  buildQualifierRowsFromActivity,
  readQualifierActivity,
  type QualifierActivity,
} from "./overviewLeaderboardBuilders";
import type { DerivedOverviewRange } from "./overviewRange";

export async function getTopQualifiersOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  return await buildTopQualifiersOverviewSection(
    ctx,
    tenantId,
    range,
    await readQualifierActivity(ctx, { tenantId, range }),
  );
}

export async function buildTopQualifiersOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: Pick<DerivedOverviewRange, "startBusinessDate" | "endBusinessDateInclusive">,
  activity: QualifierActivity,
) {
  const { rows, truncated } = await buildQualifierRowsFromActivity(
    ctx,
    {
      tenantId,
      range,
      includeAllCandidates: false,
    },
    activity,
  );

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
