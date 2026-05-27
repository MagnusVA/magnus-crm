import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { portalReadiness } from "../lib/eventTypeBookability";
import { requireTenantUser } from "../requireTenantUser";

function isConfigCalendlyActive(config: {
  calendlyActive?: boolean;
  calendlySyncStatus?: "active" | "inactive" | "deleted" | "not_returned";
}) {
  return (
    config.calendlyActive !== false &&
    config.calendlySyncStatus !== "inactive" &&
    config.calendlySyncStatus !== "deleted"
  );
}

export const getById = internalQuery({
  args: { eventTypeConfigId: v.id("eventTypeConfigs") },
  handler: async (ctx, { eventTypeConfigId }) => {
    console.log("[EventTypeConfig] getById called", { eventTypeConfigId });
    const config = await ctx.db.get(eventTypeConfigId);
    console.log("[EventTypeConfig] getById result", { found: !!config });
    return config;
  },
});

export const listForCalendlyTesting = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    activeOnly: v.optional(v.boolean()),
    count: v.optional(v.number()),
  },
  handler: async (ctx, { tenantId, activeOnly, count }) => {
    const requestedCount =
      typeof count === "number" && Number.isFinite(count) ? count : 100;
    const limit = Math.min(Math.max(Math.floor(requestedCount), 1), 500);
    const configs = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(500);

    if (configs.length >= 500) {
      console.warn(
        "[EventTypeConfig] listForCalendlyTesting reached safety bound",
        {
          tenantId,
          count: configs.length,
        },
      );
    }

    return configs
      .filter((config) => !activeOnly || isConfigCalendlyActive(config))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .slice(0, limit)
      .map((config) => ({
        eventTypeConfigId: config._id,
        uri: config.calendlyEventTypeUri,
        name: config.displayName,
        active: isConfigCalendlyActive(config),
        kind: config.calendlyKind ?? null,
        poolingType: config.calendlyPoolingType ?? null,
        durationMinutes: config.calendlyDurationMinutes ?? null,
        schedulingUrl:
          config.bookingBaseUrl ?? config.calendlySchedulingUrl ?? null,
        calendlyName: config.calendlyName ?? null,
        bookingProgramName: config.bookingProgramName ?? null,
        linkPortalEnabled: config.linkPortalEnabled ?? false,
      }));
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
      .take(500);

    if (configs.length >= 500) {
      console.warn("[EventTypeConfig] listEventTypeConfigs reached MVP bound", {
        tenantId,
        count: configs.length,
      });
    }

    console.log("[EventTypeConfig] listEventTypeConfigs result", { count: configs.length });
    return configs.map((config) => ({
      ...config,
      portalReadiness: portalReadiness(config),
    }));
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
      .take(500);

    if (configs.length >= 500) {
      console.warn(
        "[EventTypeConfig] getEventTypeConfigsWithStats reached MVP bound",
        {
          tenantId,
          count: configs.length,
        },
      );
    }

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
          portalReadiness: portalReadiness(config),
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
