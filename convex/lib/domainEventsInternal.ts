import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { emitDomainEvent } from "./domainEvents";

export const insert = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    entityType: v.union(
      v.literal("opportunity"),
      v.literal("meeting"),
      v.literal("lead"),
      v.literal("customer"),
      v.literal("followUp"),
      v.literal("user"),
      v.literal("payment"),
      v.literal("slackInstallation"),
    ),
    entityId: v.string(),
    eventType: v.string(),
    source: v.union(
      v.literal("closer"),
      v.literal("admin"),
      v.literal("pipeline"),
      v.literal("system"),
    ),
    actorUserId: v.optional(v.id("users")),
    fromStatus: v.optional(v.string()),
    toStatus: v.optional(v.string()),
    reason: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await emitDomainEvent(ctx, args);
  },
});
