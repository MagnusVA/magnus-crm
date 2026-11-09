import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { REPORT_ADMIN_ROLES } from "./lib/access";

// The booking-form questions the tenant's event types ask, for the
// Scorecard's "What predicts a sale" picker, without contact questions. Read
// from the field catalog the booking pipeline keeps; a tenant has few.
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
    const configs = new Map(
      await Promise.all(
        eventTypeConfigIds.map(async (id) => {
          const config = await ctx.db.get("eventTypeConfigs", id);
          return [id, config?.tenantId === tenantId ? config : null] as const;
        }),
      ),
    );
    // A contact question (the phone or social handle an event type maps, or
    // a label that plainly asks for one) predicts nothing and its answers are
    // hidden, so it isn't offered.
    const isContactField = (field: (typeof fields)[number]) => {
      const mappings = configs.get(field.eventTypeConfigId)?.customFieldMappings;
      return (
        field.currentLabel === mappings?.phoneField ||
        field.currentLabel === mappings?.socialHandleField ||
        /\b(e-?mail|phone|whats\s?app|telegram|instagram|tiktok|handle|username|@)\b/iu.test(field.currentLabel)
      );
    };
    return fields
      .filter((field) => !isContactField(field))
      .map((field) => ({
        id: field._id,
        fieldKey: field.fieldKey,
        currentLabel: field.currentLabel,
        eventTypeConfigId: field.eventTypeConfigId,
        eventTypeName: configs.get(field.eventTypeConfigId)?.displayName ?? null,
        firstSeenAt: field.firstSeenAt,
        lastSeenAt: field.lastSeenAt,
        valueType: field.valueType ?? null,
      }))
      .sort((left, right) => left.currentLabel.localeCompare(right.currentLabel));
  },
});
