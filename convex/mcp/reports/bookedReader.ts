import type { ReaderArgs } from "../../analytics/assistantTypes";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { buildDmCloserEfficiencyRows } from "../../dashboard/overviewLeaderboardBuilders";
import { isRangeCapErrorMessage } from "../../dashboard/overviewRange";
import { deriveOverviewRange } from "../../dashboard/overviewRange";
import { buildBookedCallsDashboard } from "../../operations/bookedCallsDashboard";
import type { getBookedCallsDashboard } from "../../operations/bookedCallsDashboard";
// Trusted tenant readers. Copied load steps preserve page semantics; builders stay shared.
export async function readGetBookedCallsDashboard(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof getBookedCallsDashboard>) {
    const range = deriveOverviewRange(args.range, Date.now(), await getTenantBusinessDay(ctx, tenantId));
    // Same machinery as the Overview's Top DM Closers section: one bounded
    // meetings read (by_tenantId_and_createdAt over the business-day UTC
    // window) for the first bookings, and the dm_team and dm_closer rows over
    // the same window for their credit. Scheduled hours come from
    // loadDmCloserScheduledHoursForRange inside.
    //
    // buildDmCloserEfficiencyRows THROWS when the meetings read exceeds its
    // cap; mirror the Overview leaderboard's handling (overview
    // LeaderboardBuilders "dm_closers" case) and turn that specific error
    // into an empty-but-valid capped payload instead of failing the query.
    let builderResult: Awaited<ReturnType<typeof buildDmCloserEfficiencyRows>>;
    try {
        builderResult = await buildDmCloserEfficiencyRows(ctx, {
            tenantId,
            range,
            includeAllCandidates: false,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown dashboard error";
        if (isRangeCapErrorMessage(message)) {
            return {
                totalBooked: 0,
                dmClosers: [],
                goal: {
                    totalTarget: null,
                    progress: 0,
                    businessDayCount: range.dayCount,
                    teams: [],
                },
                window: {
                    start: range.slackWindowStart,
                    end: range.slackWindowEnd,
                },
                capped: true,
            };
        }
        throw error;
    }
    return await buildBookedCallsDashboard(ctx, tenantId, range, builderResult);
}
