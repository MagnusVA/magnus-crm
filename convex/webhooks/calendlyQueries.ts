import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { getTenantCalendlyConnectionState } from "../lib/tenantCalendlyConnection";

/**
 * Resolves the webhook signing key for the tenant in a webhook URL.
 *
 * Fails with a reason the caller can tell apart: `invalid_id` for a
 * malformed id, `no_connection` for a tenant with no Calendly connection
 * (unknown or deleted tenant), and `no_secret` for a connected tenant whose
 * webhook secret is cleared, which happens mid-reconnect.
 */
export const getTenantSigningKey = internalQuery({
  args: { tenantId: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      tenantId: v.id("tenants"),
      webhookSecret: v.string(),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.literal("invalid_id"),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.union(v.literal("no_connection"), v.literal("no_secret")),
      tenantId: v.id("tenants"),
    }),
  ),
  handler: async (ctx, { tenantId }) => {
    const normalizedTenantId = ctx.db.normalizeId("tenants", tenantId);
    if (!normalizedTenantId) {
      return { ok: false as const, reason: "invalid_id" as const };
    }

    const connection = await getTenantCalendlyConnectionState(
      ctx,
      normalizedTenantId,
    );
    if (!connection) {
      return {
        ok: false as const,
        reason: "no_connection" as const,
        tenantId: normalizedTenantId,
      };
    }
    if (!connection.webhookSecret) {
      return {
        ok: false as const,
        reason: "no_secret" as const,
        tenantId: normalizedTenantId,
      };
    }
    return {
      ok: true as const,
      tenantId: normalizedTenantId,
      webhookSecret: connection.webhookSecret,
    };
  },
});
