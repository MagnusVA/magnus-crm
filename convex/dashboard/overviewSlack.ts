import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { buildSlackUserQualificationBreakdown } from "../reporting/lib/slackQualificationBreakdown";
import type { DerivedOverviewRange } from "./overviewRange";

export async function getTopQualifiersOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  const breakdown = await buildSlackUserQualificationBreakdown(ctx, {
    tenantId,
    windowStart: range.slackWindowStart,
    windowEnd: range.slackWindowEnd,
    limit: 5,
  });

  return {
    data: {
      totalQualified: breakdown.totalQualified,
      rows: breakdown.rows.map((row) => ({
        slackUserId: row.slackUserId,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        qualifier: row.identity,
        isDeleted: row.isDeleted,
        total: row.total,
        uniqueOpportunityCount: row.uniqueOpportunityCount,
        booked: row.booked,
        ratio: row.ratio,
      })),
    },
    truncated: breakdown.truncated,
    isEmpty: breakdown.rows.length === 0,
  };
}
