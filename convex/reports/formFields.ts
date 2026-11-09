import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { REPORT_ADMIN_ROLES } from "./lib/access";

// The booking-form questions the tenant's event types ask, for the
// Scorecard's "What predicts a sale" picker. Read from the field catalog the
// booking pipeline keeps; bounded, newest questions are few per tenant.
const MAX_FIELD_CATALOG_ROWS = 200;

export const getFieldCatalog = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    const fields = await ctx.db
      .query("eventTypeFieldCatalog")
      .withIndex("by_tenantId_and_fieldKey", (q) => q.eq("tenantId", tenantId))
      .take(MAX_FIELD_CATALOG_ROWS);
    const eventTypeConfigIds = [...new Set(fields.map((field) => field.eventTypeConfigId))];
    const eventTypeNames = new Map(
      await Promise.all(
        eventTypeConfigIds.map(async (id) => {
          const config = await ctx.db.get("eventTypeConfigs", id);
          return [id, config?.tenantId === tenantId ? (config.displayName ?? null) : null] as const;
        }),
      ),
    );
    return fields
      .map((field) => ({
        id: field._id,
        fieldKey: field.fieldKey,
        currentLabel: field.currentLabel,
        eventTypeConfigId: field.eventTypeConfigId,
        eventTypeName: eventTypeNames.get(field.eventTypeConfigId) ?? null,
        firstSeenAt: field.firstSeenAt,
        lastSeenAt: field.lastSeenAt,
        valueType: field.valueType ?? null,
      }))
      .sort((left, right) => left.currentLabel.localeCompare(right.currentLabel));
  },
});
