import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getUserDisplayName,
  reportingUserIdentity,
} from "./lib/helpers";

const MAX_EVENTS_SCAN = 5000;
const DAY_MS = 86_400_000;

export const getActionsPerCloserPerDay = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Closer events only, through the source index, so the pipeline's
    // touches (about 1,000 a day, docs/plans/phase-2-person-first.md §8)
    // don't use up the scan.
    const eventRows = await ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_source_and_occurredAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("source", "closer")
          .gte("occurredAt", startDate)
          .lt("occurredAt", endDate),
      )
      .take(MAX_EVENTS_SCAN + 1);

    const events = eventRows.slice(0, MAX_EVENTS_SCAN);
    const closerActions = new Map<Id<"users">, number>();

    for (const event of events) {
      if (!event.actorUserId) {
        continue;
      }

      closerActions.set(
        event.actorUserId,
        (closerActions.get(event.actorUserId) ?? 0) + 1,
      );
    }

    const topEntries = Array.from(closerActions.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3);
    const topCloserActors = await Promise.all(
      topEntries.map(async ([userId, count]) => {
        const user = await ctx.db.get("users", userId);
        return {
          userId,
          actorName: getUserDisplayName(user),
          actor: await reportingUserIdentity(ctx, user, "Removed user"),
          count,
        };
      }),
    );

    const totalCloserActions = Array.from(closerActions.values()).reduce(
      (sum, count) => sum + count,
      0,
    );
    const distinctCloserActors = closerActions.size;
    const daySpanDays = Math.max(1, Math.ceil((endDate - startDate) / DAY_MS));

    return {
      totalCloserActions,
      distinctCloserActors,
      daySpanDays,
      actionsPerCloserPerDay:
        distinctCloserActors > 0
          ? totalCloserActions / distinctCloserActors / daySpanDays
          : null,
      topCloserActors,
      isTruncated: eventRows.length > MAX_EVENTS_SCAN,
    };
  },
});
