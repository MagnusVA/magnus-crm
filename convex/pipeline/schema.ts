import { defineTable } from "convex/server";
import { v } from "convex/values";
import { socialPlatformValidator } from "../lib/socialPlatform";

export const deliveryStatus = v.union(
  v.literal("queued"),
  v.literal("applied"),
  v.literal("ignored"),
  v.literal("blocked"),
  v.literal("failed"),
);

/** Which of a booking's identifiers matched a person. */
export const identityMatchVia = v.union(
  v.literal("email"),
  v.literal("phone"),
  v.literal("social_handle"),
);

export const bookingReviewKind = v.union(
  // The booking applied to the person its social handle names, and its email
  // or phone also names someone else.
  v.literal("attached"),
  // The booking is blocked until an admin decides who it belongs to.
  v.literal("held"),
);

export const bookingReviewResolution = v.union(
  v.literal("merged"),
  v.literal("kept_separate"),
  v.literal("booking_applied"),
);

export const pipelineTables = {
  // One per delivery whose identifiers named more than one person: the review
  // queue of docs/adr/0001-lead-lifecycle-model.md, alerted to Slack once.
  bookingReviews: defineTable({
    tenantId: v.id("tenants"),
    deliveryId: v.id("webhookDeliveries"),
    kind: bookingReviewKind,
    status: v.union(v.literal("open"), v.literal("resolved")),
    // The delivery's blocked reason, for a held booking.
    reason: v.optional(v.string()),
    // The person the booking applied to, for an attached booking.
    leadId: v.optional(v.id("leads")),
    // The other people the booking's identifiers named.
    conflicts: v.array(
      v.object({ leadId: v.id("leads"), via: identityMatchVia }),
    ),
    // What the booking submitted, normalized: the evidence the review is
    // about. The raw payload that also holds it is deleted after retention.
    booking: v.object({
      name: v.optional(v.string()),
      email: v.optional(v.string()),
      phone: v.optional(v.string()),
      socialHandle: v.optional(
        v.object({ platform: socialPlatformValidator, handle: v.string() }),
      ),
    }),
    createdAt: v.number(),
    updatedAt: v.number(),
    alertScheduledAt: v.optional(v.number()),
    resolution: v.optional(bookingReviewResolution),
    resolvedAt: v.optional(v.number()),
    resolvedByUserId: v.optional(v.id("users")),
  })
    .index("by_deliveryId", ["deliveryId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_status_and_createdAt", [
      "tenantId",
      "status",
      "createdAt",
    ]),
  webhookRecoveryAttempts: defineTable({
    tenantId: v.id("tenants"),
    deliveryId: v.id("webhookDeliveries"),
    actorUserId: v.id("users"),
    requestedAt: v.number(),
    previousGeneration: v.number(),
    previousStatus: deliveryStatus,
    previousReason: v.optional(v.string()),
  }).index("by_tenantId_and_deliveryId", ["tenantId", "deliveryId"]),
  // Undo log for the one-off dismissal of the pre-PR #91 blocked backlog.
  webhookDeliveryDismissals: defineTable({
    tenantId: v.id("tenants"),
    deliveryId: v.id("webhookDeliveries"),
    dismissedAt: v.number(),
    previousGeneration: v.number(),
    previousStatus: deliveryStatus,
    previousReason: v.optional(v.string()),
    restoredAt: v.optional(v.number()),
  }).index("by_deliveryId", ["deliveryId"]),
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
