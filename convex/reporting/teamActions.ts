import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getUserDisplayName,
  reportingUserIdentity,
} from "./lib/helpers";

const MAX_USERS_SCAN = 200;
const MAX_EVENTS_PER_USER = 1000;
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

    // Reads each closer's events through the actor index, so pipeline touches
    // (about 1,000 a day, docs/plans/phase-2-person-first.md §8) don't use
    // up the scan.
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(MAX_USERS_SCAN);
    const closerActions = new Map<Id<"users">, number>();
    let isTruncated = false;

    for (const user of users) {
      if (user.role !== "closer") {
        continue;
      }
      const eventRows = await ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_actorUserId_and_occurredAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("actorUserId", user._id)
            .gte("occurredAt", startDate)
            .lt("occurredAt", endDate),
        )
        .take(MAX_EVENTS_PER_USER + 1);
      if (eventRows.length > MAX_EVENTS_PER_USER) {
        isTruncated = true;
      }
      const count = eventRows
        .slice(0, MAX_EVENTS_PER_USER)
        .filter((event) => event.source === "closer").length;
      if (count > 0) {
        closerActions.set(user._id, count);
      }
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
      isTruncated,
    };
  },
});
