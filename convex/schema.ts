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
    // Personal Calendly booking page URL used for follow-up scheduling links.
    personalEventTypeUri: v.optional(v.string()),

    // === v0.5b: User Soft Delete ===
    deletedAt: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
    // === End v0.5b: User Soft Delete ===
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_workosUserId", ["workosUserId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_calendlyUserUri", ["tenantId", "calendlyUserUri"])
    .index("by_tenantId_and_isActive", ["tenantId", "isActive"]),

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
    .index("by_processed_and_receivedAt", ["processed", "receivedAt"])
    .index("by_tenantId_and_eventType_and_calendlyEventUri", [
      "tenantId",
      "eventType",
      "calendlyEventUri",
    ]),

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

    // === Feature E: Lead Lifecycle Status & Merge Tracking ===
    // Status for lead merge and conversion tracking.
    // "active" = normal operating state (default for all existing + new leads).
    // "merged" = this lead was merged into another lead; mergedIntoLeadId points to the target.
    // "converted" = lead became a customer (Feature D).
    status: v.optional(
      v.union(v.literal("active"), v.literal("converted"), v.literal("merged")),
    ),

    // When status === "merged", points to the lead this was merged into.
    // Undefined for active and converted leads.
    mergedIntoLeadId: v.optional(v.id("leads")),

    // Denormalized social handles for display in lead info panels.
    // Updated when leadIdentifier records change. Array of { type, handle } pairs.
    socialHandles: v.optional(
      v.array(
        v.object({
          type: v.string(),
          handle: v.string(),
        }),
      ),
    ),

    // === Feature C: Lead Search ===
    // Denormalized full-text search field built from lead fields and
    // identifier values. Updated by the pipeline and lead mutations.
    searchText: v.optional(v.string()),
    // === End Feature C ===
    // === End Feature E ===
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    .index("by_tenantId_and_firstSeenAt", ["tenantId", "firstSeenAt"])
    .searchIndex("search_leads", {
      searchField: "searchText",
      filterFields: ["tenantId", "status"],
    }),

  // === Feature E: Multi-Identifier Lead Model ===
  leadIdentifiers: defineTable({
    tenantId: v.id("tenants"),
    leadId: v.id("leads"),
    type: v.union(
      v.literal("email"),
      v.literal("phone"),
      v.literal("instagram"),
      v.literal("tiktok"),
      v.literal("twitter"),
      v.literal("facebook"),
      v.literal("linkedin"),
      v.literal("other_social"),
    ),
    value: v.string(), // Normalized: lowercased, trimmed, @ stripped, E.164 for phone
    rawValue: v.string(), // Original value as received from the source
    source: v.union(
      v.literal("calendly_booking"), // Extracted from a Calendly webhook payload
      v.literal("manual_entry"), // Manually entered by a CRM user (Feature C)
      v.literal("merge"), // Created during a lead merge operation (Feature C)
    ),
    sourceMeetingId: v.optional(v.id("meetings")), // Which meeting provided this identifier
    confidence: v.union(
      v.literal("verified"), // Direct input by the lead (email from Calendly, phone from Calendly)
      v.literal("inferred"), // Extracted from a form field via customFieldMappings
      v.literal("suggested"), // Heuristic/AI suggestion, unconfirmed
    ),
    createdAt: v.number(), // Unix ms, for sorting and auditing
  })
    .index("by_tenantId_and_type_and_value", ["tenantId", "type", "value"])
    .index("by_leadId", ["leadId"])
    .index("by_tenantId_and_value", ["tenantId", "value"]),
  // === End Feature E ===

  // === Feature C: Lead Merge Audit Trail ===
  leadMergeHistory: defineTable({
    tenantId: v.id("tenants"),
    sourceLeadId: v.id("leads"),
    targetLeadId: v.id("leads"),
    mergedByUserId: v.id("users"),
    mergedAt: v.number(),
    identifiersMoved: v.number(),
    opportunitiesMoved: v.number(),
    meetingsMoved: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_sourceLeadId", ["sourceLeadId"])
    .index("by_targetLeadId", ["targetLeadId"]),
  // === End Feature C ===

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
      v.literal("reschedule_link_sent"),
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
    lostAt: v.optional(v.number()),
    canceledAt: v.optional(v.number()),
    noShowAt: v.optional(v.number()),
    paymentReceivedAt: v.optional(v.number()),
    lostByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
    // UTM attribution from the first booking that created this opportunity.
    // Subsequent follow-up bookings do NOT overwrite this field.
    // Undefined for opportunities created before UTM tracking was enabled.
    utmParams: v.optional(utmParamsValidator),

    // === Feature E: Potential Duplicate Detection ===
    // When the pipeline detects a fuzzy match during identity resolution,
    // it creates a new lead but stores the ID of the suspected duplicate lead here.
    // Surfaces as a banner on the meeting detail page: "This lead might be the same as [Name]."
    // Cleared when a merge is performed (Feature C) or manually dismissed.
    potentialDuplicateLeadId: v.optional(v.id("leads")),
    // === End Feature E ===
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_assignedCloserId", ["tenantId", "assignedCloserId"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    .index("by_tenantId_and_assignedCloserId_and_status", [
      "tenantId",
      "assignedCloserId",
      "status",
    ])
    .index("by_tenantId_and_potentialDuplicateLeadId", [
      "tenantId",
      "potentialDuplicateLeadId",
    ])
    .index("by_tenantId_and_eventTypeConfigId", [
      "tenantId",
      "eventTypeConfigId",
    ])
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
    .index("by_tenantId_and_status_and_createdAt", [
      "tenantId",
      "status",
      "createdAt",
    ]),

  meetings: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    assignedCloserId: v.optional(v.id("users")),
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
    completedAt: v.optional(v.number()),
    canceledAt: v.optional(v.number()),
    // UTM attribution data extracted from Calendly's tracking object.
    // Populated from the invitee.created webhook payload.
    // Undefined for meetings created before UTM tracking was enabled.
    utmParams: v.optional(utmParamsValidator),

    // Feature I: Meeting outcome classification tag.
    // Set by the closer after a meeting via dropdown on the detail page.
    // Captures the lead's intent signal — independent of opportunity status.
    // Undefined = not yet classified.
    meetingOutcome: v.optional(
      v.union(
        v.literal("interested"),
        v.literal("needs_more_info"),
        v.literal("price_objection"),
        v.literal("not_qualified"),
        v.literal("ready_to_buy"),
      ),
    ),

    // === Feature H: Closer Unavailability & Redistribution ===
    // Denormalized source closer for the most recent reassignment.
    // Undefined means the meeting has never been reassigned.
    reassignedFromCloserId: v.optional(v.id("users")),
    // === End Feature H ===

    // === Feature B: Meeting Start Time ===
    // When the closer clicked "Start Meeting". Used to compute no-show wait duration.
    // Undefined for meetings started before Feature B or webhook-driven no-shows.
    startedAt: v.optional(v.number()),
    // === End Feature B: Meeting Start Time ===

    // === Feature B: No-Show Tracking ===
    // When the no-show was recorded (by closer or webhook handler).
    noShowMarkedAt: v.optional(v.number()),
    // How long the closer waited before marking no-show (ms).
    noShowWaitDurationMs: v.optional(v.number()),
    // Structured reason for the no-show.
    noShowReason: v.optional(
      v.union(
        v.literal("no_response"),
        v.literal("late_cancel"),
        v.literal("technical_issues"),
        v.literal("other"),
      ),
    ),
    // Free-text note from the closer explaining the no-show.
    noShowNote: v.optional(v.string()),
    // Who created the no-show record.
    noShowMarkedByUserId: v.optional(v.id("users")),
    noShowSource: v.optional(
      v.union(
        v.literal("closer"),
        v.literal("calendly_webhook"),
      ),
    ),
    // === End Feature B: No-Show Tracking ===

    // === Feature B: Reschedule Chain ===
    // Links this meeting back to the no-show meeting it reschedules.
    rescheduledFromMeetingId: v.optional(v.id("meetings")),
    // === End Feature B: Reschedule Chain ===
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
    .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"])
    .index("by_tenantId_and_status_and_scheduledAt", [
      "tenantId",
      "status",
      "scheduledAt",
    ])
    .index("by_tenantId_and_meetingOutcome_and_scheduledAt", [
      "tenantId",
      "meetingOutcome",
      "scheduledAt",
    ])
    .index("by_opportunityId_and_scheduledAt", [
      "opportunityId",
      "scheduledAt",
    ])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    .index("by_tenantId_and_assignedCloserId_and_scheduledAt", [
      "tenantId",
      "assignedCloserId",
      "scheduledAt",
    ]),

  // === Feature H: Closer Unavailability & Redistribution ===
  closerUnavailability: defineTable({
    tenantId: v.id("tenants"),
    closerId: v.id("users"),
    date: v.number(), // Start-of-day UTC timestamp for the target date
    startTime: v.optional(v.number()),
    endTime: v.optional(v.number()),
    isFullDay: v.boolean(),
    reason: v.union(
      v.literal("sick"),
      v.literal("emergency"),
      v.literal("personal"),
      v.literal("other"),
    ),
    note: v.optional(v.string()),
    createdByUserId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_tenantId_and_date", ["tenantId", "date"])
    .index("by_closerId_and_date", ["closerId", "date"]),

  meetingReassignments: defineTable({
    tenantId: v.id("tenants"),
    meetingId: v.id("meetings"),
    opportunityId: v.id("opportunities"),
    fromCloserId: v.id("users"),
    toCloserId: v.id("users"),
    reason: v.string(),
    unavailabilityId: v.optional(v.id("closerUnavailability")),
    reassignedByUserId: v.id("users"),
    reassignedAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_meetingId", ["meetingId"])
    .index("by_toCloserId", ["toCloserId"])
    .index("by_fromCloserId", ["fromCloserId"])
    .index("by_unavailabilityId", ["unavailabilityId"])
    .index("by_tenantId_and_reassignedAt", ["tenantId", "reassignedAt"]),
  // === End Feature H ===

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
    createdAt: v.number(),

    // === Feature F: Event Type Field Mappings ===
    // CRM-only overlays (not from Calendly).
    // Tells the pipeline which Calendly form question maps to which identity field.
    customFieldMappings: v.optional(
      v.object({
        socialHandleField: v.optional(v.string()),
        socialHandleType: v.optional(
          v.union(
            v.literal("instagram"),
            v.literal("tiktok"),
            v.literal("twitter"),
            v.literal("other_social"),
          ),
        ),
        phoneField: v.optional(v.string()),
      }),
    ),
    // Auto-discovered from incoming bookings (system-managed, read-only from admin perspective).
    // Populates the dropdown options in the field mapping configuration dialog.
    knownCustomFieldKeys: v.optional(v.array(v.string())),
    // === End Feature F ===
  })
    .index("by_tenantId", ["tenantId"])
    .index(
      "by_tenantId_and_calendlyEventTypeUri",
      ["tenantId", "calendlyEventTypeUri"],
    ),

  // === Feature D: Lead-to-Customer Conversion ===
  customers: defineTable({
    tenantId: v.id("tenants"),
    leadId: v.id("leads"),
    fullName: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    socialHandles: v.optional(
      v.array(
        v.object({
          type: v.string(),
          handle: v.string(),
        }),
      ),
    ),
    convertedAt: v.number(),
    convertedByUserId: v.id("users"),
    winningOpportunityId: v.id("opportunities"),
    winningMeetingId: v.optional(v.id("meetings")),
    programType: v.optional(v.string()),
    notes: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("churned"),
      v.literal("paused"),
    ),
    totalPaidMinor: v.optional(v.number()),
    totalPaymentCount: v.optional(v.number()),
    paymentCurrency: v.optional(v.string()),
    churnedAt: v.optional(v.number()),
    pausedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    .index("by_tenantId_and_convertedAt", ["tenantId", "convertedAt"])
    .index("by_tenantId_and_convertedByUserId", [
      "tenantId",
      "convertedByUserId",
    ])
    .index("by_tenantId_and_convertedByUserId_and_status", [
      "tenantId",
      "convertedByUserId",
      "status",
    ]),
  // === End Feature D ===

  paymentRecords: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.optional(v.id("opportunities")),
    meetingId: v.optional(v.id("meetings")),
    closerId: v.id("users"),
    amount: v.number(),
    amountMinor: v.optional(v.number()),
    currency: v.string(),
    provider: v.string(),
    referenceCode: v.optional(v.string()),
    proofFileId: v.optional(v.id("_storage")),
    status: v.union(
      v.literal("recorded"),
      v.literal("verified"),
      v.literal("disputed"),
    ),
    verifiedAt: v.optional(v.number()),
    verifiedByUserId: v.optional(v.id("users")),
    statusChangedAt: v.optional(v.number()),
    recordedAt: v.number(),
    // === Feature D: Customer Linkage ===
    customerId: v.optional(v.id("customers")),
    contextType: v.optional(
      v.union(v.literal("opportunity"), v.literal("customer")),
    ),
    // === End Feature D ===
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_closerId", ["tenantId", "closerId"])
    .index("by_customerId", ["customerId"])
    .index("by_tenantId_and_recordedAt", ["tenantId", "recordedAt"])
    .index("by_tenantId_and_status_and_recordedAt", [
      "tenantId",
      "status",
      "recordedAt",
    ])
    .index("by_customerId_and_recordedAt", ["customerId", "recordedAt"])
    .index("by_tenantId_and_closerId_and_recordedAt", [
      "tenantId",
      "closerId",
      "recordedAt",
    ]),

  followUps: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    closerId: v.id("users"),
    type: v.optional(
      v.union(
        v.literal("scheduling_link"),
        v.literal("manual_reminder"),
      ),
    ),
    schedulingLinkUrl: v.optional(v.string()),
    calendlyEventUri: v.optional(v.string()),
    contactMethod: v.optional(
      v.union(v.literal("call"), v.literal("text")),
    ),
    reminderScheduledAt: v.optional(v.number()),
    reminderNote: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    completionNote: v.optional(v.string()),
    reason: v.union(
      v.literal("closer_initiated"),
      v.literal("cancellation_follow_up"),
      v.literal("no_show_follow_up"),
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("booked"),
      v.literal("completed"),
      v.literal("expired"),
    ),
    bookedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_closerId", ["tenantId", "closerId"])
    .index(
      "by_tenantId_and_closerId_and_status",
      ["tenantId", "closerId", "status"],
    )
    .index("by_tenantId_and_leadId_and_createdAt", [
      "tenantId",
      "leadId",
      "createdAt",
    ])
    .index("by_tenantId_and_closerId_and_type_and_status_reminderScheduledAt", [
      "tenantId",
      "closerId",
      "type",
      "status",
      "reminderScheduledAt",
    ])
    .index("by_tenantId_and_status_and_createdAt", [
      "tenantId",
      "status",
      "createdAt",
    ])
    .index("by_opportunityId_and_status", ["opportunityId", "status"]),

  // === v0.5b: Domain Events (Finding 1) ===
  domainEvents: defineTable({
    tenantId: v.id("tenants"),
    entityType: v.union(
      v.literal("opportunity"),
      v.literal("meeting"),
      v.literal("lead"),
      v.literal("customer"),
      v.literal("followUp"),
      v.literal("user"),
      v.literal("payment"),
    ),
    entityId: v.string(),
    eventType: v.string(),
    occurredAt: v.number(),
    actorUserId: v.optional(v.id("users")),
    source: v.union(
      v.literal("closer"),
      v.literal("admin"),
      v.literal("pipeline"),
      v.literal("system"),
    ),
    fromStatus: v.optional(v.string()),
    toStatus: v.optional(v.string()),
    reason: v.optional(v.string()),
    metadata: v.optional(v.string()),
  })
    .index("by_entityId", ["entityId"])
    .index("by_tenantId_and_occurredAt", ["tenantId", "occurredAt"])
    .index("by_tenantId_and_entityType_and_entityId_and_occurredAt", [
      "tenantId",
      "entityType",
      "entityId",
      "occurredAt",
    ])
    .index("by_tenantId_and_eventType_and_occurredAt", [
      "tenantId",
      "eventType",
      "occurredAt",
    ])
    .index("by_tenantId_and_actorUserId_and_occurredAt", [
      "tenantId",
      "actorUserId",
      "occurredAt",
    ]),
  // === End v0.5b: Domain Events ===

  // === v0.5b: Tenant Stats (Finding 4) ===
  tenantStats: defineTable({
    tenantId: v.id("tenants"),
    totalTeamMembers: v.number(),
    totalClosers: v.number(),
    totalOpportunities: v.number(),
    activeOpportunities: v.number(),
    wonDeals: v.number(),
    lostDeals: v.number(),
    totalRevenueMinor: v.number(),
    totalPaymentRecords: v.number(),
    totalLeads: v.number(),
    totalCustomers: v.number(),
    lastUpdatedAt: v.number(),
  }).index("by_tenantId", ["tenantId"]),
  // === End v0.5b: Tenant Stats ===

  // === v0.5b: Meeting Form Responses (Finding 2) ===
  meetingFormResponses: defineTable({
    tenantId: v.id("tenants"),
    meetingId: v.id("meetings"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    eventTypeConfigId: v.optional(v.id("eventTypeConfigs")),
    fieldCatalogId: v.optional(v.id("eventTypeFieldCatalog")),
    fieldKey: v.string(),
    questionLabelSnapshot: v.string(),
    answerText: v.string(),
    capturedAt: v.number(),
  })
    .index("by_meetingId", ["meetingId"])
    .index("by_tenantId_and_eventTypeConfigId", [
      "tenantId",
      "eventTypeConfigId",
    ])
    .index("by_tenantId_and_fieldKey", ["tenantId", "fieldKey"])
    .index("by_leadId", ["leadId"]),
  // === End v0.5b: Meeting Form Responses ===

  // === v0.5b: Event Type Field Catalog (Finding 2) ===
  eventTypeFieldCatalog: defineTable({
    tenantId: v.id("tenants"),
    eventTypeConfigId: v.id("eventTypeConfigs"),
    fieldKey: v.string(),
    currentLabel: v.string(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    valueType: v.optional(v.string()),
  })
    .index("by_tenantId_and_eventTypeConfigId", [
      "tenantId",
      "eventTypeConfigId",
    ])
    .index("by_tenantId_and_fieldKey", ["tenantId", "fieldKey"]),
  // === End v0.5b: Event Type Field Catalog ===

  // === v0.5b: Tenant Calendly Connections (Finding 14) ===
  tenantCalendlyConnections: defineTable({
    tenantId: v.id("tenants"),
    calendlyAccessToken: v.optional(v.string()),
    calendlyRefreshToken: v.optional(v.string()),
    calendlyTokenExpiresAt: v.optional(v.number()),
    calendlyRefreshLockUntil: v.optional(v.number()),
    lastTokenRefreshAt: v.optional(v.number()),
    codeVerifier: v.optional(v.string()),
    calendlyOrganizationUri: v.optional(v.string()),
    calendlyUserUri: v.optional(v.string()),
    calendlyWebhookUri: v.optional(v.string()),
    calendlyWebhookSigningKey: v.optional(v.string()),
    connectionStatus: v.optional(
      v.union(
        v.literal("connected"),
        v.literal("disconnected"),
        v.literal("token_expired"),
      ),
    ),
    lastHealthCheckAt: v.optional(v.number()),
  }).index("by_tenantId", ["tenantId"]),
  // === End v0.5b: Tenant Calendly Connections ===
});
