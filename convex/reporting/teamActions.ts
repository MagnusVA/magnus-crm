import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { assertValidDateRange, getUserDisplayName } from "./lib/helpers";

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

    const eventRows = await ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_occurredAt", (q) =>
        q.eq("tenantId", tenantId).gte("occurredAt", startDate).lt("occurredAt", endDate),
      )
      .take(MAX_EVENTS_SCAN + 1);

    const events = eventRows.slice(0, MAX_EVENTS_SCAN);
    const closerActions = new Map<Id<"users">, number>();

    for (const event of events) {
      if (event.source !== "closer" || !event.actorUserId) {
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
        const user = await ctx.db.get(userId);
        return {
          userId,
          actorName: getUserDisplayName(user),
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
