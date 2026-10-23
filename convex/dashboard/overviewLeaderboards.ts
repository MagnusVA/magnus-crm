import { BUSINESS_DAY_REBUILD_MESSAGE } from "../../lib/businessDay";
import { leadGenBusinessDayBlocked } from "../lib/businessDayRebuildState";
import type { ExpandedOverviewLeaderboard, SectionResult } from "./overviewTypes";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { buildExpandedOverviewLeaderboard } from "./overviewLeaderboardBuilders";
import { deriveOverviewRange, overviewRangeValidator } from "./overviewRange";

const leaderboardKindValidator = v.union(
  v.literal("lead_gen"),
  v.literal("qualifiers"),
  v.literal("dm_closers"),
);

export const leaderboardFilterValidator = v.object({
  search: v.optional(v.string()),
  schedule: v.optional(
    v.union(v.literal("all"), v.literal("scheduled"), v.literal("unscheduled")),
  ),
  activity: v.optional(
    v.union(
      v.literal("all"),
      v.literal("with_activity"),
      v.literal("without_activity"),
    ),
  ),
});

export const listOverviewLeaderboardRows = query({
  args: {
    kind: leaderboardKindValidator,
    range: overviewRangeValidator,
    filters: v.optional(leaderboardFilterValidator),
  },
  handler: async (ctx, args): Promise<ExpandedOverviewLeaderboard | Extract<SectionResult<never>, { status: "rebuilding" }>> => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    if (args.kind === "lead_gen" && await leadGenBusinessDayBlocked(ctx, tenantId)) {
      return {
        status: "rebuilding",
        data: null,
        truncated: false,
        message: BUSINESS_DAY_REBUILD_MESSAGE,
        errorCode: null,
      };
    }
    const range = deriveOverviewRange(args.range, Date.now(), await getTenantBusinessDay(ctx, tenantId));

    return await buildExpandedOverviewLeaderboard(ctx, {
      tenantId,
      kind: args.kind,
      range,
      filters: args.filters,
    });
  },
});
