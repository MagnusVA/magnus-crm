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

    const configs = [];
    for await (const config of ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      configs.push(config);
    }

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

    // Load all configs for the tenant
    const configs = [];
    for await (const config of ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      configs.push(config);
    }

    const statsByConfigId = new Map<
      string,
      { bookingCount: number; lastBookingAt: number | undefined }
    >();

    // Aggregate once across the tenant's opportunities instead of rescanning
    // the table once per config.
    for await (const opportunity of ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      if (!opportunity.eventTypeConfigId) {
        continue;
      }

      const existingStats = statsByConfigId.get(opportunity.eventTypeConfigId) ?? {
        bookingCount: 0,
        lastBookingAt: undefined,
      };
      existingStats.bookingCount += 1;

      if (
        opportunity.latestMeetingAt !== undefined &&
        (existingStats.lastBookingAt === undefined ||
          opportunity.latestMeetingAt > existingStats.lastBookingAt)
      ) {
        existingStats.lastBookingAt = opportunity.latestMeetingAt;
      }

      statsByConfigId.set(opportunity.eventTypeConfigId, existingStats);
    }

    const results = configs.map((config) => {
      const stats = statsByConfigId.get(config._id);
      return {
        ...config,
        bookingCount: stats?.bookingCount ?? 0,
        lastBookingAt: stats?.lastBookingAt,
        fieldCount: config.knownCustomFieldKeys?.length ?? 0,
      };
    });

    console.log("[EventTypeConfig] getEventTypeConfigsWithStats result", {
      count: results.length,
    });
    return results;
  },
});
