import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { DEFAULT_BUSINESS_DAY } from "../../lib/businessDay";
import { businessDayValidator } from "../businessDaySchema";
import { PERMISSIONS } from "../lib/permissions";
import { rejectRequest } from "../lib/observability/errors";
import {
  BATCH_SIZE_RANGE,
  INACTIVE_AFTER_DAYS_RANGE,
  inactiveCutoff,
  readResparkSettings,
  resparkSettingsValidator,
} from "../lib/respark/settings";
import { resparkPool } from "../lib/respark/state";
import { RESPARK_GROUPS } from "../lib/respark/validators";
import { requireTenantUser } from "../requireTenantUser";

// The Respark tab in Settings (docs/plans/respark.md §5.5, §6.4).

function inRange(value: number, range: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

export const getResparkSettings = query({
  // `inactiveAfterDays` previews the count for a value the admin is typing;
  // it defaults to the stored one.
  // `now` is the browser's clock, rounded to the hour, so the count moves on
  // while the tab stays open; it only affects the count.
  args: { inactiveAfterDays: v.optional(v.number()), now: v.optional(v.number()) },
  returns: v.object({
    settings: resparkSettingsValidator,
    businessDay: businessDayValidator,
    inactive: v.union(v.object({ inactiveAfterDays: v.number(), count: v.number() }), v.null()),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["settings:manage"]]);
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) throw new Error(`Missing tenant ${tenantId}`);
    const settings = readResparkSettings(tenant);
    const businessDay = tenant.businessDay ?? DEFAULT_BUSINESS_DAY;
    const days = args.inactiveAfterDays ?? settings.inactiveAfterDays;
    // A value outside the bounds can't be saved, so it gets no count.
    if (!inRange(days, INACTIVE_AFTER_DAYS_RANGE)) {
      return { settings, businessDay, inactive: null };
    }
    // Inactive in any group: one range count per group, up to the cutoff.
    const cutoff = inactiveCutoff(args.now ?? Date.now(), days);
    const counts = await resparkPool.countBatch(
      ctx,
      RESPARK_GROUPS.map((group) => ({
        namespace: tenantId,
        bounds: {
          lower: { key: [group, 0] as [typeof group, number], inclusive: true },
          upper: { key: [group, cutoff] as [typeof group, number], inclusive: true },
        },
      })),
    );
    const count = counts.reduce((sum, value) => sum + value, 0);
    return { settings, businessDay, inactive: { inactiveAfterDays: days, count } };
  },
});

export const updateResparkSettings = mutation({
  args: { inactiveAfterDays: v.number(), batchSize: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["settings:manage"]]);
    if (!inRange(args.inactiveAfterDays, INACTIVE_AFTER_DAYS_RANGE)) {
      throw rejectRequest(
        "respark.invalid_inactive_after_days",
        `Inactive after must be a whole number of days from ${INACTIVE_AFTER_DAYS_RANGE.min} to ${INACTIVE_AFTER_DAYS_RANGE.max}.`,
        { tenantId, userId, inactiveAfterDays: args.inactiveAfterDays },
      );
    }
    if (!inRange(args.batchSize, BATCH_SIZE_RANGE)) {
      throw rejectRequest(
        "respark.invalid_batch_size",
        `Batch size must be a whole number from ${BATCH_SIZE_RANGE.min} to ${BATCH_SIZE_RANGE.max}.`,
        { tenantId, userId, batchSize: args.batchSize },
      );
    }
    // The rule applies at the next read, so nothing else is rewritten.
    await ctx.db.patch("tenants", tenantId, {
      respark: { inactiveAfterDays: args.inactiveAfterDays, batchSize: args.batchSize },
    });
    return null;
  },
});
