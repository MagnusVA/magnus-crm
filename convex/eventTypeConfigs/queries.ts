import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getById = internalQuery({
  args: { eventTypeConfigId: v.id("eventTypeConfigs") },
  handler: async (ctx, { eventTypeConfigId }) => {
    console.log("[EventTypeConfig] getById called", { eventTypeConfigId });
    const config = await ctx.db.get(eventTypeConfigId);
    console.log("[EventTypeConfig] getById result", { found: !!config });
    return config;
  },
});

/**
 * List all event type configs for the current tenant.
 */
export const listEventTypeConfigs = query({
  args: {},
  handler: async (ctx) => {
    console.log("[EventTypeConfig] listEventTypeConfigs called");
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const configs = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(100);

    console.log("[EventTypeConfig] listEventTypeConfigs result", { count: configs.length });
    return configs;
  },
});

/**
 * List event type configs with booking stats for the Field Mappings tab.
 * Returns configs enriched with:
 * - bookingCount: number of opportunities linked to this event type
 * - lastBookingAt: timestamp of the most recent meeting (via denormalized latestMeetingAt)
 * - fieldCount: number of discovered custom field keys
 */
export const getEventTypeConfigsWithStats = query({
  args: {},
  handler: async (ctx) => {
    console.log("[EventTypeConfig] getEventTypeConfigsWithStats called");
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const configs = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(100);

    const results = await Promise.all(
      configs.map(async (config) => {
        let bookingCount = 0;
        let lastBookingAt: number | undefined;

        for await (const opportunity of ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
            q.eq("tenantId", tenantId).eq("eventTypeConfigId", config._id),
          )) {
          bookingCount += 1;
          if (
            opportunity.latestMeetingAt !== undefined &&
            (lastBookingAt === undefined ||
              opportunity.latestMeetingAt > lastBookingAt)
          ) {
            lastBookingAt = opportunity.latestMeetingAt;
          }
        }

        return {
          ...config,
          bookingCount,
          lastBookingAt,
          fieldCount: config.knownCustomFieldKeys?.length ?? 0,
        };
      }),
    );

    console.log("[EventTypeConfig] getEventTypeConfigsWithStats result", {
      count: results.length,
    });
    return results;
  },
});
