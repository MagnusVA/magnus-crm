import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
    ),

    // Invite
    inviteTokenHash: v.string(),
    inviteExpiresAt: v.number(),
    inviteRedeemedAt: v.optional(v.number()),

    // Calendly OAuth
    calendlyAccessToken: v.optional(v.string()),
    calendlyRefreshToken: v.optional(v.string()),
    calendlyTokenExpiresAt: v.optional(v.number()),
    calendlyOrgUri: v.optional(v.string()),
    calendlyOwnerUri: v.optional(v.string()),
    calendlyRefreshLockUntil: v.optional(v.number()),

    // Webhooks
    calendlyWebhookUri: v.optional(v.string()),
    webhookSigningKey: v.optional(v.string()),

    // Metadata
    notes: v.optional(v.string()),
    createdBy: v.string(),
    onboardingCompletedAt: v.optional(v.number()),
  })
    .index("by_workosOrgId", ["workosOrgId"])
    .index("by_status", ["status"])
    .index("by_inviteTokenHash", ["inviteTokenHash"]),

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
    .index("by_processed", ["processed"]),

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
    .index("by_tenantId_and_calendlyUserUri", ["tenantId", "calendlyUserUri"]),
});
