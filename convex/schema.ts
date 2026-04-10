import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { utmParamsValidator } from "./lib/utmParams";

export default defineSchema({
  tenants: defineTable({
    // Identity
    companyName: v.string(),
    contactEmail: v.string(),
    workosOrgId: v.string(),
    status: v.union(
      v.literal("pending_signup"),
      v.literal("pending_calendly"),
      v.literal("provisioning_webhooks"),
      v.literal("active"),
      v.literal("calendly_disconnected"),
      v.literal("suspended"),
      v.literal("invite_expired"),
    ),

    // Invite
    inviteTokenHash: v.optional(v.string()),
    inviteExpiresAt: v.number(),
    inviteRedeemedAt: v.optional(v.number()),

    // Calendly OAuth
    codeVerifier: v.optional(v.string()), // Temporary: PKCE code verifier during OAuth
    calendlyAccessToken: v.optional(v.string()),
    calendlyRefreshToken: v.optional(v.string()),
    calendlyTokenExpiresAt: v.optional(v.number()),
    calendlyOrgUri: v.optional(v.string()),
    calendlyOwnerUri: v.optional(v.string()),
    calendlyRefreshLockUntil: v.optional(v.number()),
    lastTokenRefreshAt: v.optional(v.number()),
    webhookProvisioningStartedAt: v.optional(v.number()),

    // Webhooks
    calendlyWebhookUri: v.optional(v.string()),
    webhookSigningKey: v.optional(v.string()),

    // Metadata
    notes: v.optional(v.string()),
    createdBy: v.string(),
    onboardingCompletedAt: v.optional(v.number()),
    tenantOwnerId: v.optional(v.id("users")),
  })
    .index("by_contactEmail", ["contactEmail"])
    .index("by_workosOrgId", ["workosOrgId"])
    .index("by_status", ["status"])
    .index("by_inviteTokenHash", ["inviteTokenHash"])
    .index("by_status_and_inviteExpiresAt", ["status", "inviteExpiresAt"]),

  users: defineTable({
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
    email: v.string(),
    fullName: v.optional(v.string()),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
    calendlyUserUri: v.optional(v.string()),
    calendlyMemberName: v.optional(v.string()), // Denormalized from calendlyOrgMembers for query efficiency

    // Team-member invitation tracking.
    // Set when a tenant admin invites a closer or admin via WorkOS sendInvitation.
    // "pending" = invited but not yet signed up; "accepted" = sign-up complete.
    // Undefined for users created through other flows (e.g. tenant-owner onboarding).
    invitationStatus: v.optional(
      v.union(v.literal("pending"), v.literal("accepted")),
    ),
    // WorkOS invitation ID — used to revoke invitation if user is removed before sign-up.
    workosInvitationId: v.optional(v.string()),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_workosUserId", ["workosUserId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_calendlyUserUri", ["tenantId", "calendlyUserUri"]),

  rawWebhookEvents: defineTable({
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
    eventType: v.string(),
    payload: v.string(),
    processed: v.boolean(),
    receivedAt: v.number(),
  })
    .index("by_tenantId_and_eventType", ["tenantId", "eventType"])
    .index("by_calendlyEventUri", ["calendlyEventUri"])
    .index("by_processed", ["processed"])
    .index("by_processed_and_receivedAt", ["processed", "receivedAt"]),

  calendlyOrgMembers: defineTable({
    tenantId: v.id("tenants"),
    calendlyUserUri: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    calendlyRole: v.optional(v.string()),
    matchedUserId: v.optional(v.id("users")),
    lastSyncedAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_calendlyUserUri", ["tenantId", "calendlyUserUri"])
    .index("by_tenantId_and_matchedUserId", ["tenantId", "matchedUserId"])
    .index("by_tenantId_and_lastSyncedAt", ["tenantId", "lastSyncedAt"]),

  leads: defineTable({
    tenantId: v.id("tenants"),
    email: v.string(),
    fullName: v.optional(v.string()),
    phone: v.optional(v.string()),
    customFields: v.optional(v.any()),
    firstSeenAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_email", ["tenantId", "email"]),

  opportunities: defineTable({
    tenantId: v.id("tenants"),
    leadId: v.id("leads"),
    assignedCloserId: v.optional(v.id("users")),
    hostCalendlyUserUri: v.optional(v.string()),
    hostCalendlyEmail: v.optional(v.string()),
    hostCalendlyName: v.optional(v.string()),
    eventTypeConfigId: v.optional(v.id("eventTypeConfigs")),
    status: v.union(
      v.literal("scheduled"),
      v.literal("in_progress"),
      v.literal("payment_received"),
      v.literal("follow_up_scheduled"),
      v.literal("lost"),
      v.literal("canceled"),
      v.literal("no_show"),
    ),
    calendlyEventUri: v.optional(v.string()),
    // Denormalized meeting references for query efficiency (see @plans/caching/caching.md)
    latestMeetingId: v.optional(v.id("meetings")),
    latestMeetingAt: v.optional(v.number()),
    nextMeetingId: v.optional(v.id("meetings")), // Soonest "scheduled" meeting by scheduledAt
    nextMeetingAt: v.optional(v.number()),
    cancellationReason: v.optional(v.string()),
    canceledBy: v.optional(v.string()),
    lostReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    // UTM attribution from the first booking that created this opportunity.
    // Subsequent follow-up bookings do NOT overwrite this field.
    // Undefined for opportunities created before UTM tracking was enabled.
    utmParams: v.optional(utmParamsValidator),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_assignedCloserId", ["tenantId", "assignedCloserId"])
    .index("by_tenantId_and_status", ["tenantId", "status"]),

  meetings: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    calendlyEventUri: v.string(),
    calendlyInviteeUri: v.string(),
    zoomJoinUrl: v.optional(v.string()), // Legacy Zoom-only field. Keep during migration window.
    meetingJoinUrl: v.optional(v.string()), // Generic online join URL from Calendly location payloads.
    meetingLocationType: v.optional(v.string()), // Raw/normalized Calendly location.type. String to avoid schema churn for new provider types.
    scheduledAt: v.number(),
    durationMinutes: v.number(),
    status: v.union(
      v.literal("scheduled"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("canceled"),
      v.literal("no_show"),
    ),
    notes: v.optional(v.string()),
    leadName: v.optional(v.string()), // Denormalized from lead for query efficiency
    createdAt: v.number(),
    // UTM attribution data extracted from Calendly's tracking object.
    // Populated from the invitee.created webhook payload.
    // Undefined for meetings created before UTM tracking was enabled.
    utmParams: v.optional(utmParamsValidator),
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
    .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"]),

  eventTypeConfigs: defineTable({
    tenantId: v.id("tenants"),
    calendlyEventTypeUri: v.string(),
    displayName: v.string(),
    paymentLinks: v.optional(
      v.array(
        v.object({
          provider: v.string(),
          label: v.string(),
          url: v.string(),
        }),
      ),
    ),
    roundRobinEnabled: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index(
      "by_tenantId_and_calendlyEventTypeUri",
      ["tenantId", "calendlyEventTypeUri"],
    ),

  paymentRecords: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
    closerId: v.id("users"),
    amount: v.number(),
    currency: v.string(),
    provider: v.string(),
    referenceCode: v.optional(v.string()),
    proofFileId: v.optional(v.id("_storage")),
    status: v.union(
      v.literal("recorded"),
      v.literal("verified"),
      v.literal("disputed"),
    ),
    recordedAt: v.number(),
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_closerId", ["tenantId", "closerId"]),

  followUps: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    closerId: v.id("users"),
    schedulingLinkUrl: v.optional(v.string()),
    calendlyEventUri: v.optional(v.string()),
    reason: v.union(
      v.literal("closer_initiated"),
      v.literal("cancellation_follow_up"),
      v.literal("no_show_follow_up"),
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("booked"),
      v.literal("expired"),
    ),
    createdAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_closerId", ["tenantId", "closerId"]),
});
