import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { enqueueDelivery } from "./delivery";
import { deliveryStatus } from "./schema";

const entry = v.object({
  deliveryId: v.id("webhookDeliveries"),
  generation: v.number(),
  status: deliveryStatus,
  reason: v.optional(v.string()),
  rawAvailable: v.boolean(),
  eventType: v.string(),
  occurredAt: v.number(),
});
export const preview = query({
  args: { deliveryIds: v.array(v.id("webhookDeliveries")) },
  returns: v.array(entry),
  handler: async (ctx, { deliveryIds }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_admin",
      "tenant_master",
    ]);
    if (
      !deliveryIds.length ||
      deliveryIds.length > 50 ||
      new Set(deliveryIds).size !== deliveryIds.length
    )
      throw new Error("Select 1–50 distinct deliveries");
    return await Promise.all(
      deliveryIds.map(async (deliveryId) => {
        const row = await ctx.db.get("webhookDeliveries", deliveryId);
        if (!row || row.tenantId !== tenantId)
          throw new Error("Delivery not found");
        return {
          deliveryId,
          generation: row.generation,
          status: row.status,
          reason: row.reason,
          rawAvailable: Boolean(
            await ctx.db.get("rawWebhookEvents", row.rawEventId),
          ),
          eventType: row.eventType,
          occurredAt: row.occurredAt,
        };
      }),
    );
  },
});
async function retryOne(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  actorUserId: Id<"users">,
  item: Infer<typeof entry>,
) {
  const row = await ctx.db.get("webhookDeliveries", item.deliveryId);
  if (!row || row.tenantId !== tenantId)
    throw new Error("Delivery not found");
  if (
    row.generation !== item.generation ||
    row.status !== item.status ||
    row.reason !== item.reason
  )
    throw new Error("Recovery preview is stale");
  if (row.status !== "blocked" && row.status !== "failed")
    throw new Error("Only blocked or failed deliveries can be retried");
  const raw = await ctx.db.get("rawWebhookEvents", row.rawEventId);
  if (!raw || raw.tenantId !== tenantId)
    throw new Error("Original payload is unavailable");
  await ctx.db.insert("webhookRecoveryAttempts", {
    tenantId,
    deliveryId: row._id,
    actorUserId,
    requestedAt: Date.now(),
    previousGeneration: row.generation,
    previousStatus: row.status,
    previousReason: row.reason,
  });
  await ctx.db.patch("rawWebhookEvents", raw._id, {
    processed: false,
    processingReason: undefined,
  });
  await enqueueDelivery(ctx, row._id);
}

function checkSelection(ids: Id<"webhookDeliveries">[]) {
  if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length)
    throw new Error("Select 1–50 distinct deliveries");
}

export const retry = mutation({
  args: { manifest: v.array(entry) },
  returns: v.null(),
  handler: async (ctx, { manifest }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_admin",
      "tenant_master",
    ]);
    checkSelection(manifest.map((e) => e.deliveryId));
    for (const item of manifest) {
      await retryOne(ctx, tenantId, userId, item);
    }
    return null;
  },
});

/**
 * The same retry, run from the CLI by an operator on an admin's behalf. The
 * admin is named as `actorUserId` and recorded on each recovery attempt.
 */
export const retryAsOperator = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    actorUserId: v.id("users"),
    deliveryIds: v.array(v.id("webhookDeliveries")),
  },
  returns: v.null(),
  handler: async (ctx, { tenantId, actorUserId, deliveryIds }) => {
    const actor = await ctx.db.get("users", actorUserId);
    if (
      !actor ||
      actor.tenantId !== tenantId ||
      !actor.isActive ||
      (actor.role !== "tenant_admin" && actor.role !== "tenant_master")
    )
      throw new Error("The actor must be an active admin of the tenant");
    checkSelection(deliveryIds);
    for (const deliveryId of deliveryIds) {
      const row = await ctx.db.get("webhookDeliveries", deliveryId);
      if (!row || row.tenantId !== tenantId)
        throw new Error("Delivery not found");
      await retryOne(ctx, tenantId, actorUserId, {
        deliveryId,
        generation: row.generation,
        status: row.status,
        reason: row.reason,
        rawAvailable: true,
        eventType: row.eventType,
        occurredAt: row.occurredAt,
      });
    }
    return null;
  },
});
