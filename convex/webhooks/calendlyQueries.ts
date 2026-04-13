import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { getTenantCalendlyConnectionState } from "../lib/tenantCalendlyConnection";

export const getTenantSigningKey = internalQuery({
  args: { tenantId: v.string() },
  handler: async (ctx, { tenantId }) => {
    console.log(`[Webhook] getTenantSigningKey called: tenantId=${tenantId}`);

    const normalizedTenantId = ctx.db.normalizeId("tenants", tenantId);
    if (!normalizedTenantId) {
      console.warn(`[Webhook] getTenantSigningKey: tenantId=${tenantId} could not be normalized — not found`);
      return null;
    }

    const connection = await getTenantCalendlyConnectionState(
      ctx,
      normalizedTenantId,
    );
    if (!connection?.webhookSecret) {
      console.warn(`[Webhook] getTenantSigningKey: tenant found but has no signing key`);
      return null;
    }

    console.log(`[Webhook] getTenantSigningKey: found tenant with signing key present`);
    return {
      tenantId: normalizedTenantId,
      webhookSecret: connection.webhookSecret,
    };
  },
});
