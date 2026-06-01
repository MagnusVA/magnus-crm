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
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const range = deriveOverviewRange(args.range, Date.now());

    return await buildExpandedOverviewLeaderboard(ctx, {
      tenantId,
      kind: args.kind,
      range,
      filters: args.filters,
    });
  },
});
