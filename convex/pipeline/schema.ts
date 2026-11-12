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
  // The booking is blocked until an admin says whether its new email belongs
  // to the one person its phone names: "Is this the same person?".
  v.literal("identity_check"),
);

export const bookingReviewResolution = v.union(
  v.literal("merged"),
  v.literal("kept_separate"),
  v.literal("booking_applied"),
  // An identity_check review's answers.
  v.literal("same_person"),
  v.literal("different_person"),
);

/**
 * Why a booking is held, in IDs only: the rule that held it and the people it
 * matched on which detail. The panel explains a hold from it without rerunning
 * the match. Never names, emails or phones.
 */
export const bookingHold = v.object({
  cause: v.string(),
  matches: v.array(v.object({ leadId: v.id("leads"), via: identityMatchVia })),
  // More people matched than were kept.
  truncated: v.boolean(),
  // The earlier booking from the same email this one waits behind.
  waitingOnDeliveryId: v.optional(v.id("webhookDeliveries")),
});

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
    // Set once Slack accepts the alert. An open review without it is posted
    // when an admin first picks a booking review channel.
    alertPostedAt: v.optional(v.number()),
    resolution: v.optional(bookingReviewResolution),
    resolvedAt: v.optional(v.number()),
    resolvedByUserId: v.optional(v.id("users")),
  })
    .index("by_deliveryId", ["deliveryId"])
    .index("by_tenantId_and_leadId_and_resolution", [
      "tenantId",
      "leadId",
      "resolution",
    ])
    .index("by_tenantId_and_status_and_createdAt", [
      "tenantId",
      "status",
      "createdAt",
    ]),
  // An admin's answer to "Is this the same person?": whether a booking email
  // belongs to a person matched only by phone. The resolver reads it for later
  // bookings with that email. A booking whose email is a placeholder gets an
  // answer for that one delivery. Exactly one of `email` and `deliveryId` is
  // set, and there is one answer per email and person.
  bookingIdentityDecisions: defineTable({
    tenantId: v.id("tenants"),
    // The booking's normalized, non-placeholder email: the evidence decided on.
    email: v.optional(v.string()),
    deliveryId: v.optional(v.id("webhookDeliveries")),
    leadId: v.id("leads"),
    decision: v.union(v.literal("same_person"), v.literal("different_person")),
    reviewId: v.id("bookingReviews"),
    decidedByUserId: v.id("users"),
    decidedAt: v.number(),
  })
    .index("by_tenantId_and_email_and_leadId", ["tenantId", "email", "leadId"])
    .index("by_deliveryId", ["deliveryId"]),
  webhookRecoveryAttempts: defineTable({
    tenantId: v.id("tenants"),
    deliveryId: v.id("webhookDeliveries"),
    actorUserId: v.id("users"),
    requestedAt: v.number(),
    previousGeneration: v.number(),
    previousStatus: deliveryStatus,
    previousReason: v.optional(v.string()),
  }),
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
    // The cancel's own `rescheduled` flag: Calendly moved the booking to a new
    // invitee, whose invitee.created names this one in `old_invitee`.
    rescheduled: v.optional(v.boolean()),
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
    // Set while a booking is held: why, in IDs only.
    hold: v.optional(bookingHold),
    // A held invitee.created's SHA-256 of tenant and booking email, kept while
    // it is retried and cleared once it applies or is ignored. Held bookings
    // from one email apply oldest first by it. Never a readable email.
    holdKey: v.optional(v.string()),
    // When Slack was told about a held booking that has no review.
    heldAlertedAt: v.optional(v.number()),
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
    .index("by_status_and_receivedAt", ["status", "receivedAt"])
    .index("by_tenantId_and_holdKey_and_occurredAt", [
      "tenantId",
      "holdKey",
      "occurredAt",
    ]),
};
