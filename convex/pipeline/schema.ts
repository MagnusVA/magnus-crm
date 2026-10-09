import { defineTable } from "convex/server";
import { v } from "convex/values";

export const deliveryStatus = v.union(
  v.literal("queued"),
  v.literal("applied"),
  v.literal("ignored"),
  v.literal("blocked"),
  v.literal("failed"),
);

export const pipelineTables = {
  webhookRecoveryAttempts: defineTable({
    tenantId: v.id("tenants"),
    deliveryId: v.id("webhookDeliveries"),
    actorUserId: v.id("users"),
    requestedAt: v.number(),
    previousGeneration: v.number(),
    previousStatus: deliveryStatus,
    previousReason: v.optional(v.string()),
  }).index("by_tenantId_and_deliveryId", ["tenantId", "deliveryId"]),
  calendlyBookingFacts: defineTable({
    tenantId: v.id("tenants"),
    eventUri: v.string(),
    inviteeUri: v.string(),
    canceledAt: v.optional(v.number()),
    cancellationReason: v.optional(v.string()),
    noShowAt: v.optional(v.number()),
    noShow: v.optional(v.boolean()),
  }).index("by_tenantId_and_eventUri_and_inviteeUri", [
    "tenantId",
    "eventUri",
    "inviteeUri",
  ]),
  // Compact receipts outlive raw payload retention and Workpool's work records.
  webhookDeliveries: defineTable({
    tenantId: v.id("tenants"),
    key: v.string(),
    eventType: v.string(),
    inviteeUri: v.string(),
    eventUri: v.optional(v.string()),
    rawEventId: v.id("rawWebhookEvents"),
    occurredAt: v.number(),
    receivedAt: v.number(),
    status: deliveryStatus,
    reason: v.optional(v.string()),
    processedAt: v.optional(v.number()),
    generation: v.number(),
    workId: v.optional(v.string()),
    meetingId: v.optional(v.id("meetings")),
    opportunityId: v.optional(v.id("opportunities")),
    leadId: v.optional(v.id("leads")),
  })
    .index("by_tenantId_and_key", ["tenantId", "key"])
    .index("by_rawEventId", ["rawEventId"])
    .index("by_tenantId_and_inviteeUri_and_status", [
      "tenantId",
      "inviteeUri",
      "status",
    ])
    .index("by_tenantId_and_receivedAt", ["tenantId", "receivedAt"])
    .index("by_tenantId_and_status_and_receivedAt", [
      "tenantId",
      "status",
      "receivedAt",
    ])
    .index("by_status_and_receivedAt", ["status", "receivedAt"]),
};
