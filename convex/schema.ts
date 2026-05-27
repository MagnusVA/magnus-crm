import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  leadGenAuditMatchSourceValidator,
  leadGenAuditMatchStatusValidator,
  leadGenOriginKindValidator,
  leadGenSourceValidator,
  leadGenWeekdayValidator,
} from "./leadGen/validators";
import {
  attributionResolutionValidator,
  bookingProgramMappingStatusValidator,
} from "./lib/attribution/validators";
import {
  slackQualificationResultKindValidator,
} from "./operations/validators";
import { opportunityStatusValidator } from "./opportunities/validators";
import { portalPasswordHashParamsValidator } from "./lib/linkPortal/validators";
import { paymentOriginValidator, paymentTypeValidator } from "./lib/paymentTypes";
import { socialPlatformValidator } from "./lib/socialPlatform";
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

    // Metadata
    notes: v.optional(v.string()),
    createdBy: v.string(),
    onboardingCompletedAt: v.optional(v.number()),
    tenantOwnerId: v.optional(v.id("users")),
    // One tenant-wide count target for one Honduras 1am-to-1am business day.
    // Undefined means no team goal configured. Field name retained for migration safety.
    slackQualificationDailyTeamQuota: v.optional(v.number()),
    // Phase 0 Billing Ops release gate. Undefined is treated as disabled.
    billingOpsEnabled: v.optional(v.boolean()),
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
      v.literal("lead_generator"),
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
    isActive: v.boolean(),
    // === End v0.5b: User Soft Delete ===
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_workosUserId", ["workosUserId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_calendlyUserUri", ["tenantId", "calendlyUserUri"])
    .index("by_tenantId_and_isActive", ["tenantId", "isActive"]),

  leadGenSettings: defineTable({
    tenantId: v.id("tenants"),
    correctionWindowMinutes: v.optional(v.number()),
    rawExportMaxRows: v.number(),
    duplicateDisplayMode: v.union(
      v.literal("show_all"),
      v.literal("group_by_prospect"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_tenantId", ["tenantId"]),

  leadGenWorkers: defineTable({
    tenantId: v.id("tenants"),
    userId: v.id("users"),
    workosUserId: v.string(),
    displayName: v.optional(v.string()),
    email: v.string(),
    teamId: v.optional(v.id("attributionTeams")),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_userId", ["tenantId", "userId"])
    .index("by_tenantId_and_workosUserId", ["tenantId", "workosUserId"])
    .index("by_tenantId_and_isActive", ["tenantId", "isActive"])
    .index("by_tenantId_and_teamId", ["tenantId", "teamId"]),

  leadGenWorkerSchedules: defineTable({
    tenantId: v.id("tenants"),
    workerId: v.id("leadGenWorkers"),
    userId: v.id("users"),
    weekday: leadGenWeekdayValidator,
    scheduledHours: v.number(),
    updatedByUserId: v.id("users"),
    updatedAt: v.number(),
  })
    .index("by_tenantId_and_workerId", ["tenantId", "workerId"])
    .index("by_tenantId_and_workerId_and_weekday", [
      "tenantId",
      "workerId",
      "weekday",
    ]),

  leadGenProspects: defineTable({
    tenantId: v.id("tenants"),
    firstSource: leadGenSourceValidator,
    latestSource: leadGenSourceValidator,
    dedupeKey: v.string(),
    normalizedHandle: v.string(),
    rawHandle: v.string(),
    profileUrl: v.string(),
    firstCapturedByWorkerId: v.id("leadGenWorkers"),
    firstCapturedAt: v.number(),
    lastSubmittedByWorkerId: v.id("leadGenWorkers"),
    lastSubmittedAt: v.number(),
    latestOriginKind: leadGenOriginKindValidator,
    latestOriginValue: v.optional(v.string()),
    contactAttemptCount: v.number(),
    distinctWorkerCount: v.number(),
    currentAuditMatchId: v.optional(v.id("leadGenAuditMatches")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_dedupeKey", ["tenantId", "dedupeKey"])
    .index("by_tenantId_and_normalizedHandle", [
      "tenantId",
      "normalizedHandle",
    ])
    .index("by_tenantId_and_latestSource", ["tenantId", "latestSource"])
    .index("by_tenantId_and_lastSubmittedAt", [
      "tenantId",
      "lastSubmittedAt",
    ])
    .index("by_tenantId_and_firstCapturedByWorkerId", [
      "tenantId",
      "firstCapturedByWorkerId",
    ])
    .index("by_tenantId_and_currentAuditMatchId", [
      "tenantId",
      "currentAuditMatchId",
    ]),

  leadGenSubmissions: defineTable({
    tenantId: v.id("tenants"),
    prospectId: v.id("leadGenProspects"),
    workerId: v.id("leadGenWorkers"),
    userId: v.id("users"),
    teamId: v.optional(v.id("attributionTeams")),
    source: leadGenSourceValidator,
    originKind: leadGenOriginKindValidator,
    originValue: v.optional(v.string()),
    originRankable: v.boolean(),
    clientSubmissionKey: v.optional(v.string()),
    submittedAt: v.number(),
    createdAt: v.number(),
    voidedAt: v.optional(v.number()),
    voidedByUserId: v.optional(v.id("users")),
    voidReason: v.optional(v.string()),
  })
    .index("by_tenantId_and_submittedAt", ["tenantId", "submittedAt"])
    .index("by_tenantId_and_workerId_and_submittedAt", [
      "tenantId",
      "workerId",
      "submittedAt",
    ])
    .index("by_tenantId_and_teamId_and_submittedAt", [
      "tenantId",
      "teamId",
      "submittedAt",
    ])
    .index("by_tenantId_and_source_and_submittedAt", [
      "tenantId",
      "source",
      "submittedAt",
    ])
    .index("by_tenantId_and_prospectId", ["tenantId", "prospectId"])
    .index("by_tenantId_and_prospectId_and_submittedAt", [
      "tenantId",
      "prospectId",
      "submittedAt",
    ])
    .index("by_tenantId_and_prospectId_and_workerId", [
      "tenantId",
      "prospectId",
      "workerId",
    ])
    .index("by_tenantId_and_workerId_and_clientSubmissionKey", [
      "tenantId",
      "workerId",
      "clientSubmissionKey",
    ]),

  leadGenDailyStats: defineTable({
    tenantId: v.id("tenants"),
    statKey: v.string(),
    dayKey: v.string(),
    workerId: v.id("leadGenWorkers"),
    userId: v.id("users"),
    teamId: v.optional(v.id("attributionTeams")),
    source: leadGenSourceValidator,
    submissions: v.number(),
    uniqueProspectsSubmitted: v.number(),
    duplicateProspectSubmissions: v.number(),
    scheduledHours: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId_and_statKey", ["tenantId", "statKey"])
    .index("by_tenantId_and_dayKey", ["tenantId", "dayKey"])
    .index("by_tenantId_and_workerId_and_dayKey", [
      "tenantId",
      "workerId",
      "dayKey",
    ])
    .index("by_tenantId_and_teamId_and_dayKey", [
      "tenantId",
      "teamId",
      "dayKey",
    ])
    .index("by_tenantId_and_source_and_dayKey", [
      "tenantId",
      "source",
      "dayKey",
    ]),

  leadGenOriginStats: defineTable({
    tenantId: v.id("tenants"),
    originKey: v.string(),
    dayKey: v.string(),
    source: leadGenSourceValidator,
    originKind: leadGenOriginKindValidator,
    originValue: v.string(),
    submissions: v.number(),
    uniqueProspectsSubmitted: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId_and_dayKey", ["tenantId", "dayKey"])
    .index("by_tenantId_and_originKey_and_dayKey", [
      "tenantId",
      "originKey",
      "dayKey",
    ])
    .index("by_tenantId_and_source_and_dayKey", [
      "tenantId",
      "source",
      "dayKey",
    ]),

  leadGenTeamOriginStats: defineTable({
    tenantId: v.id("tenants"),
    statKey: v.string(),
    dayKey: v.string(),
    teamId: v.optional(v.id("attributionTeams")),
    source: leadGenSourceValidator,
    originKind: leadGenOriginKindValidator,
    originKey: v.string(),
    originValue: v.string(),
    submissions: v.number(),
    uniqueProspectsSubmitted: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId_and_statKey", ["tenantId", "statKey"])
    .index("by_tenantId_and_dayKey", ["tenantId", "dayKey"])
    .index("by_tenantId_and_teamId_and_dayKey", [
      "tenantId",
      "teamId",
      "dayKey",
    ])
    .index("by_tenantId_and_source_and_dayKey", [
      "tenantId",
      "source",
      "dayKey",
    ])
    .index("by_tenantId_and_teamId_and_source_and_dayKey", [
      "tenantId",
      "teamId",
      "source",
      "dayKey",
    ]),

  leadGenAuditMatches: defineTable({
    tenantId: v.id("tenants"),
    prospectId: v.id("leadGenProspects"),
    leadId: v.id("leads"),
    opportunityId: v.optional(v.id("opportunities")),
    matchSource: leadGenAuditMatchSourceValidator,
    matchStatus: leadGenAuditMatchStatusValidator,
    matchedVia: v.literal("social_handle"),
    normalizedHandle: v.string(),
    createdByUserId: v.optional(v.id("users")),
    rejectedByUserId: v.optional(v.id("users")),
    rejectedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId_and_prospectId", ["tenantId", "prospectId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_opportunityId", ["tenantId", "opportunityId"])
    .index("by_tenantId_and_matchStatus", ["tenantId", "matchStatus"])
    .index("by_tenantId_and_prospectId_and_leadId", [
      "tenantId",
      "prospectId",
      "leadId",
    ]),

  leadGenCorrectionEvents: defineTable({
    tenantId: v.id("tenants"),
    targetType: v.union(
      v.literal("prospect"),
      v.literal("submission"),
      v.literal("audit_match"),
    ),
    targetId: v.string(),
    correctionKind: v.union(
      v.literal("edited"),
      v.literal("voided"),
      v.literal("match_rejected"),
      v.literal("match_accepted"),
    ),
    reason: v.string(),
    beforeSnapshot: v.string(),
    afterSnapshot: v.string(),
    correctedByUserId: v.id("users"),
    correctedAt: v.number(),
  })
    .index("by_tenantId_and_correctedAt", ["tenantId", "correctedAt"])
    .index("by_tenantId_and_targetType_and_targetId", [
      "tenantId",
      "targetType",
      "targetId",
    ]),

  rawWebhookEvents: defineTable({
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
    eventType: v.string(),
    payload: v.string(),
    processed: v.boolean(),
    receivedAt: v.number(),
  })
    .index("by_tenantId_and_eventType", ["tenantId", "eventType"])
    .index("by_tenantId_and_receivedAt", ["tenantId", "receivedAt"])
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
    // Widened for Slack-qualified leads. Calendly-created leads still write
    // email; Slack-created leads may begin with only name + social handle.
    email: v.optional(v.string()),
    fullName: v.optional(v.string()),
    phone: v.optional(v.string()),
    customFields: v.optional(v.record(v.string(), v.string())),
    firstSeenAt: v.number(),
    updatedAt: v.number(),

    // === Feature E: Lead Lifecycle Status & Merge Tracking ===
    // Status for lead merge and conversion tracking.
    // "active" = normal operating state (default for all existing + new leads).
    // "merged" = this lead was merged into another lead; mergedIntoLeadId points to the target.
    // "converted" = lead became a customer (Feature D).
    status: v.union(
      v.literal("active"),
      v.literal("converted"),
      v.literal("merged"),
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
      ...socialPlatformValidator.members,
    ),
    value: v.string(), // Normalized: lowercased, trimmed, @ stripped, E.164 for phone
    rawValue: v.string(), // Original value as received from the source
    source: v.union(
      v.literal("calendly_booking"), // Extracted from a Calendly webhook payload
      v.literal("manual_entry"), // Manually entered by a CRM user (Feature C)
      v.literal("merge"), // Created during a lead merge operation (Feature C)
      v.literal("side_deal"), // Created during manual side-deal opportunity entry
      v.literal("slack_qualified"), // Created from Slack /qualify-lead
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

  // Shared tenant DM team registry. The table name is retained for migration
  // safety; it is used by both DM attribution links and Lead Gen Ops reporting.
  attributionTeams: defineTable({
    tenantId: v.id("tenants"),
    slug: v.string(),
    displayName: v.string(),
    utmSource: v.string(),
    normalizedUtmSource: v.string(),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_slug", ["tenantId", "slug"])
    .index("by_tenantId_and_normalizedUtmSource", [
      "tenantId",
      "normalizedUtmSource",
    ]),

  dmClosers: defineTable({
    tenantId: v.id("tenants"),
    teamId: v.id("attributionTeams"),
    slug: v.string(),
    displayName: v.string(),
    utmMedium: v.string(),
    normalizedUtmMedium: v.string(),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId_and_teamId", ["tenantId", "teamId"])
    .index("by_tenantId_and_slug", ["tenantId", "slug"])
    .index("by_tenantId_and_normalizedUtmMedium", [
      "tenantId",
      "normalizedUtmMedium",
    ]),

  linkPortalConfigs: defineTable({
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    isEnabled: v.boolean(),
    passwordHash: v.optional(v.string()),
    passwordSalt: v.optional(v.string()),
    passwordHashParams: v.optional(portalPasswordHashParamsValidator),
    passwordSetAt: v.optional(v.number()),
    passwordRotatedAt: v.optional(v.number()),
    sessionVersion: v.number(),
    sessionTtlSeconds: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_publicSlug", ["publicSlug"]),

  linkPortalCampaignPresets: defineTable({
    tenantId: v.id("tenants"),
    slug: v.string(),
    label: v.string(),
    utmCampaign: v.string(),
    normalizedUtmCampaign: v.string(),
    isDefault: v.boolean(),
    isActive: v.boolean(),
    sortOrder: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_isActive", ["tenantId", "isActive"])
    .index("by_tenantId_and_normalizedUtmCampaign", [
      "tenantId",
      "normalizedUtmCampaign",
    ]),

  linkPortalAuthAttempts: defineTable({
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    ipHash: v.string(),
    failedCount: v.number(),
    windowStartedAt: v.number(),
    lockedUntil: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_tenantId_and_ipHash", ["tenantId", "ipHash"])
    .index("by_publicSlug_and_ipHash", ["publicSlug", "ipHash"]),

  linkPortalCopyEvents: defineTable({
    tenantId: v.id("tenants"),
    sessionIdHash: v.string(),
    eventTypeConfigId: v.id("eventTypeConfigs"),
    bookingProgramId: v.id("tenantPrograms"),
    attributionTeamId: v.id("attributionTeams"),
    dmCloserId: v.id("dmClosers"),
    campaignPresetId: v.id("linkPortalCampaignPresets"),
    utmCampaign: v.string(),
    copiedAt: v.number(),
  })
    .index("by_tenantId_and_copiedAt", ["tenantId", "copiedAt"])
    .index("by_tenantId_and_dmCloserId_and_copiedAt", [
      "tenantId",
      "dmCloserId",
      "copiedAt",
    ])
    .index("by_tenantId_and_eventTypeConfigId_and_copiedAt", [
      "tenantId",
      "eventTypeConfigId",
      "copiedAt",
    ]),

  opportunities: defineTable({
    tenantId: v.id("tenants"),
    leadId: v.id("leads"),
    assignedCloserId: v.optional(v.id("users")),
    hostCalendlyUserUri: v.optional(v.string()),
    hostCalendlyEmail: v.optional(v.string()),
    hostCalendlyName: v.optional(v.string()),
    eventTypeConfigId: v.optional(v.id("eventTypeConfigs")),
    status: v.union(
      v.literal("qualified_pending"),
      v.literal("scheduled"),
      v.literal("in_progress"),
      v.literal("meeting_overran"),
      v.literal("payment_received"),
      v.literal("follow_up_scheduled"),
      v.literal("reschedule_link_sent"),
      v.literal("lost"),
      v.literal("canceled"),
      v.literal("no_show"),
    ),
    // Widened for side-deals rollout. Undefined legacy rows normalize to
    // "calendly" until the production backfill is verified and schema narrows.
    source: v.optional(
      v.union(
        v.literal("calendly"),
        v.literal("side_deal"),
        v.literal("slack_qualified"),
      ),
    ),
    // Slack attribution. Keep immutable Slack IDs here and render display names
    // through the normalized slackUsers directory.
    qualifiedBy: v.optional(
      v.object({
        slackUserId: v.string(),
        slackTeamId: v.string(),
        submittedAt: v.number(),
      }),
    ),
    // Idempotency key for manual opportunity creation. Undefined for Calendly rows.
    manualCreationKey: v.optional(v.string()),
    calendlyEventUri: v.optional(v.string()),
    // Denormalized meeting references for query efficiency (see @plans/caching/caching.md)
    latestMeetingId: v.optional(v.id("meetings")),
    latestMeetingAt: v.optional(v.number()),
    nextMeetingId: v.optional(v.id("meetings")), // Soonest "scheduled" meeting by scheduledAt
    nextMeetingAt: v.optional(v.number()),
    cancellationReason: v.optional(v.string()),
    canceledBy: v.optional(v.string()),
    notes: v.optional(v.string()),
    lostReason: v.optional(v.string()),
    lostAt: v.optional(v.number()),
    canceledAt: v.optional(v.number()),
    noShowAt: v.optional(v.number()),
    paymentReceivedAt: v.optional(v.number()),
    lostByUserId: v.optional(v.id("users")),
    // Denormalized cross-source activity timestamp for entity-browse sorting.
    // Backfilled for legacy rows before this becomes required.
    latestActivityAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    // UTM attribution from the first booking that created this opportunity.
    // Subsequent follow-up bookings do NOT overwrite this field.
    // Undefined for opportunities created before UTM tracking was enabled.
    utmParams: v.optional(utmParamsValidator),
    firstBookingProgramId: v.optional(v.id("tenantPrograms")),
    firstBookingProgramName: v.optional(v.string()),
    firstBookingProgramMappingStatus: v.optional(
      bookingProgramMappingStatusValidator,
    ),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramName: v.optional(v.string()),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
    attributionResolution: v.optional(attributionResolutionValidator),
    attributionResolvedAt: v.optional(v.number()),
    attributionResolutionVersion: v.optional(v.number()),
    firstBookedAt: v.optional(v.number()),
    firstMeetingId: v.optional(v.id("meetings")),
    firstMeetingAt: v.optional(v.number()),
    qualifiedAt: v.optional(v.number()),

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
    .index("by_tenantId_and_leadId_and_source_and_status_and_createdAt", [
      "tenantId",
      "leadId",
      "source",
      "status",
      "createdAt",
    ])
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
    ])
    .index("by_tenantId_and_assignedCloserId_and_createdAt", [
      "tenantId",
      "assignedCloserId",
      "createdAt",
    ])
    .index("by_tenantId_and_assignedCloserId_and_status_and_createdAt", [
      "tenantId",
      "assignedCloserId",
      "status",
      "createdAt",
    ])
    .index("by_tenantId_and_manualCreationKey", [
      "tenantId",
      "manualCreationKey",
    ])
    .index("by_tenantId_and_source_and_createdAt", [
      "tenantId",
      "source",
      "createdAt",
    ])
    .index("by_tenantId_and_source_and_status_and_createdAt", [
      "tenantId",
      "source",
      "status",
      "createdAt",
    ])
    .index("by_source_and_status_and_createdAt", [
      "source",
      "status",
      "createdAt",
    ])
    .index("by_tenantId_and_latestActivityAt", [
      "tenantId",
      "latestActivityAt",
    ])
    .index("by_tenantId_and_status_and_latestActivityAt", [
      "tenantId",
      "status",
      "latestActivityAt",
    ])
    .index("by_tenantId_and_source_and_latestActivityAt", [
      "tenantId",
      "source",
      "latestActivityAt",
    ])
    .index("by_tenantId_and_source_and_status_and_latestActivityAt", [
      "tenantId",
      "source",
      "status",
      "latestActivityAt",
    ])
    .index("by_tenantId_and_assignedCloserId_and_latestActivityAt", [
      "tenantId",
      "assignedCloserId",
      "latestActivityAt",
    ])
    .index("by_tenantId_and_assignedCloserId_and_status_and_latestActivityAt", [
      "tenantId",
      "assignedCloserId",
      "status",
      "latestActivityAt",
    ])
    .index("by_tenantId_and_assignedCloserId_and_source_and_latestActivityAt", [
      "tenantId",
      "assignedCloserId",
      "source",
      "latestActivityAt",
    ])
    .index(
      "by_tenantId_assignedCloserId_source_status_latestActivityAt",
      [
        "tenantId",
        "assignedCloserId",
        "source",
        "status",
        "latestActivityAt",
      ],
    )
    .index("by_tenantId_and_source_and_qualifiedAt", [
      "tenantId",
      "source",
      "qualifiedAt",
    ])
    .index("by_tenantId_and_attributionTeamId_and_qualifiedAt", [
      "tenantId",
      "attributionTeamId",
      "qualifiedAt",
    ])
    .index("by_tenantId_and_dmCloserId_and_qualifiedAt", [
      "tenantId",
      "dmCloserId",
      "qualifiedAt",
    ])
    .index("by_tenantId_and_firstBookingProgramId_and_qualifiedAt", [
      "tenantId",
      "firstBookingProgramId",
      "qualifiedAt",
    ])
    .index("by_tenantId_and_soldProgramId_and_qualifiedAt", [
      "tenantId",
      "soldProgramId",
      "qualifiedAt",
    ])
    .index("by_tenantId_and_firstMeetingAt", ["tenantId", "firstMeetingAt"]),

  opportunitySearch: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    assignedCloserId: v.optional(v.id("users")),
    source: v.union(
      v.literal("calendly"),
      v.literal("side_deal"),
      v.literal("slack_qualified"),
    ),
    status: v.union(
      v.literal("qualified_pending"),
      v.literal("scheduled"),
      v.literal("in_progress"),
      v.literal("meeting_overran"),
      v.literal("payment_received"),
      v.literal("follow_up_scheduled"),
      v.literal("reschedule_link_sent"),
      v.literal("lost"),
      v.literal("canceled"),
      v.literal("no_show"),
    ),
    latestActivityAt: v.number(),
    activityDayKey: v.string(),
    activityWeekKey: v.string(),
    activityMonthKey: v.string(),
    searchText: v.string(),
    updatedAt: v.number(),
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_latestActivityAt", [
      "tenantId",
      "latestActivityAt",
    ])
    .searchIndex("search_opportunities", {
      searchField: "searchText",
      filterFields: [
        "tenantId",
        "source",
        "status",
        "assignedCloserId",
        "activityDayKey",
        "activityWeekKey",
        "activityMonthKey",
      ],
    }),

  slackQualificationEvents: defineTable({
    tenantId: v.id("tenants"),
    installationId: v.id("slackInstallations"),
    leadId: v.optional(v.id("leads")),
    opportunityId: v.optional(v.id("opportunities")),
    resultKind: slackQualificationResultKindValidator,
    qualifiedBy: v.object({
      slackUserId: v.string(),
      slackTeamId: v.string(),
      submittedAt: v.number(),
    }),
    slackUserId: v.string(),
    slackTeamId: v.string(),
    fullNameSnapshot: v.string(),
    platform: socialPlatformValidator,
    handleSnapshot: v.string(),
    submittedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_tenantId_and_submittedAt", ["tenantId", "submittedAt"])
    .index("by_tenantId_and_slackUserId_and_submittedAt", [
      "tenantId",
      "slackUserId",
      "submittedAt",
    ])
    .index("by_tenantId_and_opportunityId", [
      "tenantId",
      "opportunityId",
    ])
    .index("by_tenantId_and_opportunityId_and_submittedAt", [
      "tenantId",
      "opportunityId",
      "submittedAt",
    ])
    .index("by_tenantId_and_leadId_and_submittedAt", [
      "tenantId",
      "leadId",
      "submittedAt",
    ]),

  operationsQualificationRows: defineTable({
    tenantId: v.id("tenants"),
    qualificationEventId: v.id("slackQualificationEvents"),
    opportunityId: v.optional(v.id("opportunities")),
    leadId: v.optional(v.id("leads")),
    slackUserId: v.string(),
    slackTeamId: v.string(),
    resultKind: slackQualificationResultKindValidator,
    opportunityStatus: v.optional(opportunityStatusValidator),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    bookingProgramName: v.optional(v.string()),
    bookingProgramMappingStatus: v.optional(bookingProgramMappingStatusValidator),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramName: v.optional(v.string()),
    qualifiedAt: v.number(),
    firstBookedAt: v.optional(v.number()),
    firstMeetingId: v.optional(v.id("meetings")),
    firstMeetingAt: v.optional(v.number()),
    assignedCloserId: v.optional(v.id("users")),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
    attributionResolution: attributionResolutionValidator,
    searchText: v.string(),
    updatedAt: v.number(),
  })
    .index("by_qualificationEventId", ["qualificationEventId"])
    .index("by_tenantId_and_qualifiedAt", ["tenantId", "qualifiedAt"])
    .index("by_tenantId_and_opportunityStatus_and_qualifiedAt", [
      "tenantId",
      "opportunityStatus",
      "qualifiedAt",
    ])
    .index("by_tenantId_and_bookingProgramId_and_qualifiedAt", [
      "tenantId",
      "bookingProgramId",
      "qualifiedAt",
    ])
    .index("by_tenantId_and_soldProgramId_and_qualifiedAt", [
      "tenantId",
      "soldProgramId",
      "qualifiedAt",
    ])
    .index("by_tenantId_and_slackUserId_and_qualifiedAt", [
      "tenantId",
      "slackUserId",
      "qualifiedAt",
    ])
    .index("by_tenantId_and_attributionTeamId_and_qualifiedAt", [
      "tenantId",
      "attributionTeamId",
      "qualifiedAt",
    ])
    .index("by_tenantId_and_dmCloserId_and_qualifiedAt", [
      "tenantId",
      "dmCloserId",
      "qualifiedAt",
    ])
    .index("by_tenantId_and_firstMeetingAt", ["tenantId", "firstMeetingAt"])
    .index("by_tenantId_and_bookingProgramId_and_firstMeetingAt", [
      "tenantId",
      "bookingProgramId",
      "firstMeetingAt",
    ])
    .index("by_tenantId_and_soldProgramId_and_firstMeetingAt", [
      "tenantId",
      "soldProgramId",
      "firstMeetingAt",
    ])
    .index("by_tenantId_and_slackUserId_and_firstMeetingAt", [
      "tenantId",
      "slackUserId",
      "firstMeetingAt",
    ])
    .index("by_tenantId_and_assignedCloserId_and_firstMeetingAt", [
      "tenantId",
      "assignedCloserId",
      "firstMeetingAt",
    ])
    .index("by_tenantId_and_attributionTeamId_and_firstMeetingAt", [
      "tenantId",
      "attributionTeamId",
      "firstMeetingAt",
    ])
    .index("by_tenantId_and_dmCloserId_and_firstMeetingAt", [
      "tenantId",
      "dmCloserId",
      "firstMeetingAt",
    ])
    .searchIndex("search_qualification_rows", {
      searchField: "searchText",
      filterFields: [
        "tenantId",
        "opportunityStatus",
        "bookingProgramId",
        "soldProgramId",
        "slackUserId",
        "attributionTeamId",
        "dmCloserId",
      ],
    }),

  meetings: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    assignedCloserId: v.id("users"),
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
      v.literal("meeting_overran"),
    ),
    // === v0.6: Call Classification ===
    // Set when a meeting is created or backfilled for historical records.
    // "new" = first booking on an opportunity, "follow_up" = subsequent booking.
    callClassification: v.optional(
      v.union(
        v.literal("new"),
        v.literal("follow_up"),
      ),
    ),
    // === End v0.6: Call Classification ===
    // DEPRECATED (as of meeting-comments feature — see plans/meeting-comments/):
    // All frontend reads/writes removed. Calendly's meeting_notes_plain webhook
    // still populates this field for newly-created meetings. Phase 4 migrates
    // existing data to the meetingComments table. Schedule full removal via the
    // `convex-migration-helper` skill once the Calendly webhook is rerouted to
    // create a system comment instead.
    notes: v.optional(v.string()),
    leadName: v.optional(v.string()), // Denormalized from lead for query efficiency
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    canceledAt: v.optional(v.number()),
    // === v0.6: Meeting Time Tracking ===
    // When the closer explicitly ended the meeting.
    // Distinct from completedAt, which may be set by other flows.
    stoppedAt: v.optional(v.number()),
    // Attribution for each explicit meeting timestamp.
    // - "closer": closer used the Start/End Meeting lifecycle controls
    // - "closer_no_show": closer marked a true no-show after waiting
    // - "admin_manual": admin entered verified times during review resolution
    // - "system": reserved for a future safety-net auto-close flow
    startedAtSource: v.optional(
      v.union(
        v.literal("closer"),
        v.literal("admin_manual"),
      ),
    ),
    stoppedAtSource: v.optional(
      v.union(
        v.literal("closer"),
        v.literal("closer_no_show"),
        v.literal("admin_manual"),
        v.literal("system"),
      ),
    ),
    // === End v0.6: Meeting Time Tracking ===
    // UTM attribution data extracted from Calendly's tracking object.
    // Populated from the invitee.created webhook payload.
    // Undefined for meetings created before UTM tracking was enabled.
    utmParams: v.optional(utmParamsValidator),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    bookingProgramName: v.optional(v.string()),
    bookingProgramMappingStatus: v.optional(bookingProgramMappingStatusValidator),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramName: v.optional(v.string()),
    opportunityStatus: v.optional(opportunityStatusValidator),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
    attributionResolution: v.optional(attributionResolutionValidator),
    attributionResolvedAt: v.optional(v.number()),
    attributionResolutionVersion: v.optional(v.number()),
    utmTruncated: v.optional(v.boolean()),

    // DEAD FIELD (as of meeting-comments feature — see plans/meeting-comments/).
    // All read and write code paths are deleted — no production code references
    // this field. Existing data is preserved but orphaned. Full removal requires
    // a widen-migrate-narrow migration; schedule via the `convex-migration-helper`
    // skill. The `by_tenantId_and_meetingOutcome_and_scheduledAt` index below
    // must stay until the field is removed.
    meetingOutcome: v.optional(
      v.union(
        v.literal("interested"),
        v.literal("needs_more_info"),
        v.literal("price_objection"),
        v.literal("not_qualified"),
        v.literal("ready_to_buy"),
      ),
    ),
    // v2: Fathom recording link — proof of attendance.
    // Available on all meetings. Checked by admin when reviewing flagged meetings.
    fathomLink: v.optional(v.string()),
    fathomLinkSavedAt: v.optional(v.number()),

    // === Feature H: Closer Unavailability & Redistribution ===
    // Denormalized source closer for the most recent reassignment.
    // Undefined means the meeting has never been reassigned.
    reassignedFromCloserId: v.optional(v.id("users")),
    // === End Feature H ===

    // === Feature B: Meeting Start Time ===
    // When the closer clicked "Start Meeting". Used to compute no-show wait duration.
    // Undefined for meetings started before Feature B or webhook-driven no-shows.
    startedAt: v.optional(v.number()),
    // === v0.6: Meeting Time Tracking ===
    // Computed when a closer starts a meeting after its scheduled time.
    lateStartDurationMs: v.optional(v.number()),
    // Legacy pre-v0.6b field name retained as optional so older production
    // meetings remain schema-valid during the fresh-start rollout. New writes
    // use `exceededScheduledDurationMs`.
    overranDurationMs: v.optional(v.number()),
    // Computed when the meeting ends after its scheduled duration.
    exceededScheduledDurationMs: v.optional(v.number()),
    // === End v0.6: Meeting Time Tracking ===
    attendanceCheckId: v.optional(v.id("_scheduled_functions")),
    overranDetectedAt: v.optional(v.number()),
    // Links the meeting to its meeting-overran review record.
    reviewId: v.optional(v.id("meetingReviews")),

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
    operationsStatsSyncedAt: v.optional(v.number()),
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
    .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"])
    .index("by_tenantId_and_status_and_scheduledAt", [
      "tenantId",
      "status",
      "scheduledAt",
    ])
    // DEAD INDEX — see DEAD FIELD comment on meetingOutcome above. Cannot remove
    // independently of the field. Remove together in the follow-up migration.
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
    ])
    .index("by_tenantId_and_attributionTeamId_and_scheduledAt", [
      "tenantId",
      "attributionTeamId",
      "scheduledAt",
    ])
    .index("by_tenantId_and_dmCloserId_and_scheduledAt", [
      "tenantId",
      "dmCloserId",
      "scheduledAt",
    ])
    .index("by_tenantId_and_bookingProgramId_and_scheduledAt", [
      "tenantId",
      "bookingProgramId",
      "scheduledAt",
    ])
    .index("by_tenantId_and_soldProgramId_and_scheduledAt", [
      "tenantId",
      "soldProgramId",
      "scheduledAt",
    ])
    .index("by_tenantId_and_opportunityStatus_and_scheduledAt", [
      "tenantId",
      "opportunityStatus",
      "scheduledAt",
    ]),

  operationsMeetingDailyStats: defineTable({
    tenantId: v.id("tenants"),
    dayKey: v.string(),
    assignedCloserId: v.id("users"),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
    opportunityStatus: v.optional(opportunityStatusValidator),
    meetingStatus: v.union(
      v.literal("scheduled"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("canceled"),
      v.literal("no_show"),
      v.literal("meeting_overran"),
    ),
    count: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId_and_dayKey", ["tenantId", "dayKey"])
    .index("by_tenantId_and_assignedCloserId_and_dayKey", [
      "tenantId",
      "assignedCloserId",
      "dayKey",
    ]),

  // Replaces the single-textarea meeting notes flow with a multi-user comment log.
  // Soft-delete keeps the audit trail intact while hiding removed comments.
  meetingComments: defineTable({
    tenantId: v.id("tenants"),
    meetingId: v.id("meetings"),
    authorId: v.id("users"),
    content: v.string(),
    createdAt: v.number(),
    editedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_meetingId_and_createdAt", ["meetingId", "createdAt"])
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"]),

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

  // === Meeting Overran Review System ===
  meetingReviews: defineTable({
    tenantId: v.id("tenants"),
    meetingId: v.id("meetings"),
    opportunityId: v.id("opportunities"),
    closerId: v.id("users"),
    category: v.literal("meeting_overran"),
    closerResponse: v.optional(
      v.union(
        v.literal("forgot_to_press"),
        v.literal("did_not_attend"),
      ),
    ),
    closerNote: v.optional(v.string()),
    closerStatedOutcome: v.optional(
      v.union(
        v.literal("sale_made"),
        v.literal("follow_up_needed"),
        v.literal("lead_not_interested"),
        v.literal("lead_no_show"),
        v.literal("other"),
      ),
    ),
    estimatedMeetingDurationMinutes: v.optional(v.number()),
    closerRespondedAt: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("resolved"),
    ),
    resolvedAt: v.optional(v.number()),
    resolvedByUserId: v.optional(v.id("users")),
    // Admin-entered actual meeting times captured while resolving
    // forgot-to-press reviews.
    manualStartedAt: v.optional(v.number()),
    manualStoppedAt: v.optional(v.number()),
    timesSetByUserId: v.optional(v.id("users")),
    timesSetAt: v.optional(v.number()),
    resolutionAction: v.optional(
      v.union(
        v.literal("log_payment"),
        v.literal("schedule_follow_up"),
        v.literal("mark_no_show"),
        v.literal("mark_lost"),
        v.literal("acknowledged"),
        v.literal("disputed"),
      ),
    ),
    resolutionNote: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_tenantId_and_status_and_createdAt", [
      "tenantId",
      "status",
      "createdAt",
    ])
    .index("by_meetingId", ["meetingId"])
    .index("by_tenantId_and_closerId_and_createdAt", [
      "tenantId",
      "closerId",
      "createdAt",
    ])
    .index("by_tenantId_and_resolvedAt", ["tenantId", "resolvedAt"]),
  // === End Meeting Overran Review System ===

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
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    bookingProgramName: v.optional(v.string()),
    bookingProgramMappingStatus: v.optional(bookingProgramMappingStatusValidator),
    bookingBaseUrl: v.optional(v.string()),
    bookingUrlSource: v.optional(
      v.union(
        v.literal("admin_entered"),
        v.literal("imported_sheet"),
        v.literal("calendly_synced"),
      ),
    ),
    linkPortalEnabled: v.optional(v.boolean()),
    // Extended event types allow booking further in advance (e.g. 2-3 days out).
    isExtended: v.optional(v.boolean()),

    // Calendly-owned metadata from GET /event_types. All fields remain
    // optional for widen-only rollout safety.
    calendlyName: v.optional(v.string()),
    displayNameSource: v.optional(
      v.union(
        v.literal("admin_entered"),
        v.literal("calendly_synced"),
        v.literal("webhook_discovered"),
      ),
    ),
    calendlySchedulingUrl: v.optional(v.string()),
    calendlySlug: v.optional(v.string()),
    calendlyActive: v.optional(v.boolean()),
    calendlyDeletedAt: v.optional(v.string()),
    calendlyCreatedAt: v.optional(v.string()),
    calendlyUpdatedAt: v.optional(v.string()),
    calendlyDurationMinutes: v.optional(v.number()),
    calendlyKind: v.optional(v.string()),
    calendlyType: v.optional(v.string()),
    calendlyBookingMethod: v.optional(v.string()),
    calendlyPoolingType: v.optional(v.string()),
    calendlySecret: v.optional(v.boolean()),
    calendlyAdminManaged: v.optional(v.boolean()),
    calendlyColor: v.optional(v.string()),
    calendlyLocale: v.optional(v.string()),
    calendlyOwnerUri: v.optional(v.string()),
    calendlyProfileName: v.optional(v.string()),
    calendlySyncStatus: v.optional(
      v.union(
        v.literal("active"),
        v.literal("inactive"),
        v.literal("deleted"),
        v.literal("not_returned"),
      ),
    ),
    lastCalendlySeenAt: v.optional(v.number()),
    lastCalendlySyncedAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  })
    .index("by_tenantId", ["tenantId"])
    .index(
      "by_tenantId_and_calendlyEventTypeUri",
      ["tenantId", "calendlyEventTypeUri"],
    )
    .index("by_tenantId_and_bookingProgramId", [
      "tenantId",
      "bookingProgramId",
    ]),

  tenantPrograms: defineTable({
    tenantId: v.id("tenants"),
    name: v.string(),
    normalizedName: v.string(),
    description: v.optional(v.string()),
    defaultCurrency: v.optional(v.string()),
    archivedAt: v.optional(v.number()),
    createdAt: v.number(),
    createdByUserId: v.id("users"),
    updatedAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_archivedAt", ["tenantId", "archivedAt"])
    .index("by_tenantId_and_normalizedName", [
      "tenantId",
      "normalizedName",
    ]),

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
    programId: v.id("tenantPrograms"),
    programName: v.string(),
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
    .index("by_tenantId_and_programId", ["tenantId", "programId"])
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
    attributedCloserId: v.optional(v.id("users")),
    amountMinor: v.number(),
    currency: v.string(),
    recordedByUserId: v.id("users"),
    commissionable: v.boolean(),
    programId: v.id("tenantPrograms"),
    programName: v.string(),
    paymentType: paymentTypeValidator,
    referenceCode: v.optional(v.string()),
    proofFileId: v.optional(v.id("_storage")),
    // Optional free-form note captured by the admin at the time of logging.
    // Used for audit context on post-conversion payments
    // (e.g. "re-enrollment after 6-month gap", "partial chargeback resolved").
    note: v.optional(v.string()),
    status: v.union(
      v.literal("recorded"),
      v.literal("verified"),
      v.literal("disputed"),
    ),
    verifiedAt: v.optional(v.number()),
    verifiedByUserId: v.optional(v.id("users")),
    statusChangedAt: v.optional(v.number()),
    // `recordedAt` is the effective "paid at" timestamp used by all reporting
    // queries. For admin-logged post-conversion payments this may be
    // back-dated via the `paidAt` argument on `recordCustomerPayment`.
    recordedAt: v.number(),
    // === Feature D: Customer Linkage ===
    customerId: v.optional(v.id("customers")),
    originatingOpportunityId: v.optional(v.id("opportunities")),
    contextType: v.union(
      v.literal("opportunity"),
      v.literal("customer"),
    ),
    origin: paymentOriginValidator,
    // === End Feature D ===
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_opportunityId_and_recordedAt", [
      "opportunityId",
      "recordedAt",
    ])
    .index("by_originatingOpportunityId", ["originatingOpportunityId"])
    .index("by_originatingOpportunityId_and_recordedAt", [
      "originatingOpportunityId",
      "recordedAt",
    ])
    .index("by_tenantId", ["tenantId"])
    .index("by_customerId", ["customerId"])
    .index("by_tenantId_and_recordedAt", ["tenantId", "recordedAt"])
    .index("by_tenantId_and_status_and_recordedAt", [
      "tenantId",
      "status",
      "recordedAt",
    ])
    .index("by_customerId_and_recordedAt", ["customerId", "recordedAt"])
    .index("by_tenantId_and_attributedCloserId_and_recordedAt", [
      "tenantId",
      "attributedCloserId",
      "recordedAt",
    ])
    .index("by_tenantId_and_commissionable_and_recordedAt", [
      "tenantId",
      "commissionable",
      "recordedAt",
    ])
    .index("by_tenantId_and_origin_and_recordedAt", [
      "tenantId",
      "origin",
      "recordedAt",
    ])
    .index("by_tenantId_and_programId_and_recordedAt", [
      "tenantId",
      "programId",
      "recordedAt",
    ])
    .index("by_tenantId_and_paymentType_and_recordedAt", [
      "tenantId",
      "paymentType",
      "recordedAt",
    ])
    .index("by_tenantId_and_status_and_programId_and_recordedAt", [
      "tenantId",
      "status",
      "programId",
      "recordedAt",
    ])
    .index("by_tenantId_and_status_and_paymentType_and_recordedAt", [
      "tenantId",
      "status",
      "paymentType",
      "recordedAt",
    ])
    .index("by_tenantId_status_programId_paymentType_recordedAt", [
      "tenantId",
      "status",
      "programId",
      "paymentType",
      "recordedAt",
    ]),

  billingExportEvents: defineTable({
    tenantId: v.id("tenants"),
    actorUserId: v.id("users"),
    filtersJson: v.string(),
    exactCount: v.number(),
    exportedCount: v.number(),
    truncated: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
    .index("by_tenantId_and_actorUserId_and_createdAt", [
      "tenantId",
      "actorUserId",
      "createdAt",
    ]),

  billingOpsReadinessChecks: defineTable({
    tenantId: v.id("tenants"),
    actorSubject: v.string(),
    status: v.union(v.literal("passed"), v.literal("failed")),
    checkedAt: v.number(),
    aggregateBackfilledAt: v.optional(v.number()),
    filtersJson: v.string(),
    summaryJson: v.string(),
  })
    .index("by_tenantId_and_checkedAt", ["tenantId", "checkedAt"])
    .index("by_tenantId_and_status_and_checkedAt", [
      "tenantId",
      "status",
      "checkedAt",
    ]),

  followUps: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    closerId: v.id("users"),
    type: v.union(
      v.literal("scheduling_link"),
      v.literal("manual_reminder"),
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
    // Structured completion tag for reminder-driven outcomes.
    // Legacy follow-ups remain valid without backfill during the rollout.
    completionOutcome: v.optional(
      v.union(
        v.literal("payment_received"),
        v.literal("lost"),
        v.literal("no_response_rescheduled"),
        v.literal("no_response_given_up"),
        v.literal("no_response_close_only"),
      ),
    ),
    reason: v.union(
      v.literal("closer_initiated"),
      v.literal("cancellation_follow_up"),
      v.literal("no_show_follow_up"),
      v.literal("admin_initiated"),
      v.literal("overran_review_resolution"),
      v.literal("stale_opportunity_nudge"),
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("booked"),
      v.literal("completed"),
      v.literal("expired"),
    ),
    bookedAt: v.optional(v.number()),
    createdAt: v.number(),
    createdByUserId: v.optional(v.id("users")),
    createdSource: v.optional(
      v.union(
        v.literal("closer"),
        v.literal("admin"),
        v.literal("system"),
      ),
    ),
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
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
    .index("by_tenantId_and_createdSource_and_createdAt", [
      "tenantId",
      "createdSource",
      "createdAt",
    ])
    .index("by_opportunityId_and_status", ["opportunityId", "status"])
    .index("by_opportunityId_and_status_and_reason", [
      "opportunityId",
      "status",
      "reason",
    ]),

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
      v.literal("slackInstallation"),
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
    totalCommissionableFinalRevenueMinor: v.optional(v.number()),
    totalCommissionableDepositRevenueMinor: v.optional(v.number()),
    totalNonCommissionableFinalRevenueMinor: v.optional(v.number()),
    totalNonCommissionableDepositRevenueMinor: v.optional(v.number()),
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
    webhookProvisioningStartedAt: v.optional(v.number()),

    eventTypeSyncLockUntil: v.optional(v.number()),
    lastEventTypeSyncStartedAt: v.optional(v.number()),
    lastEventTypeSyncCompletedAt: v.optional(v.number()),
    lastEventTypeSyncStatus: v.optional(
      v.union(
        v.literal("success"),
        v.literal("failed"),
        v.literal("skipped"),
      ),
    ),
    lastEventTypeSyncError: v.optional(v.string()),
    lastEventTypeSyncCount: v.optional(v.number()),
    lastEventTypeSyncSummary: v.optional(
      v.object({
        totalSeen: v.number(),
        created: v.number(),
        updated: v.number(),
        unchanged: v.number(),
        inactive: v.number(),
        deleted: v.number(),
        notReturned: v.number(),
        questionsMerged: v.number(),
      }),
    ),
  }).index("by_tenantId", ["tenantId"]),
  // === End v0.5b: Tenant Calendly Connections ===

  // === Slack Bot v1: OAuth Install & Token Rotation ===
  slackInstallations: defineTable({
    tenantId: v.id("tenants"),

    // Slack workspace identity. Inbound payloads must join on teamId + appId,
    // not teamId alone, because dev/prod Slack apps can share a workspace.
    teamId: v.string(),
    teamName: v.string(),
    enterpriseId: v.optional(v.string()),
    isEnterpriseInstall: v.boolean(),
    appId: v.string(),

    botUserId: v.string(),
    botAccessToken: v.string(),
    scopes: v.array(v.string()),

    // Phase 5 configures these; until then the install can still be active.
    notifyChannelId: v.optional(v.string()),
    notifyChannelName: v.optional(v.string()),
    staleReminderChannelId: v.optional(v.string()),
    staleReminderChannelName: v.optional(v.string()),
    notifyChannelError: v.optional(
      v.object({
        code: v.string(),
        channelId: v.string(),
        channelName: v.optional(v.string()),
        occurredAt: v.number(),
      }),
    ),
    staleReminderChannelError: v.optional(
      v.object({
        code: v.string(),
        channelId: v.string(),
        channelName: v.optional(v.string()),
        occurredAt: v.number(),
      }),
    ),

    installedByWorkosUserId: v.string(),
    installedAt: v.number(),

    tokenExpiresAt: v.number(),
    refreshToken: v.string(),
    lastRefreshedAt: v.optional(v.number()),
    refreshLockHolder: v.optional(v.string()),
    refreshLockAcquiredAt: v.optional(v.number()),

    status: v.union(
      v.literal("active"),
      v.literal("token_expired"),
      v.literal("revoked"),
      v.literal("uninstalled"),
    ),
    uninstalledAt: v.optional(v.number()),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_teamId", ["teamId"])
    .index("by_teamId_and_appId", ["teamId", "appId"])
    .index("by_status_and_tokenExpiresAt", ["status", "tokenExpiresAt"]),

  slackOAuthStates: defineTable({
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
    stateHash: v.string(),
    nonceHash: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    .index("by_stateHash", ["stateHash"])
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * Per-tenant Slack-user directory. Opportunities store only immutable Slack
   * IDs; this table carries the mutable display snapshot.
   */
  slackUsers: defineTable({
    tenantId: v.id("tenants"),
    installationId: v.id("slackInstallations"),
    slackUserId: v.string(),
    slackTeamId: v.string(),
    username: v.optional(v.string()),
    realName: v.optional(v.string()),
    displayName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    timezone: v.optional(v.string()),
    isBot: v.boolean(),
    isDeleted: v.boolean(),
    crmUserId: v.optional(v.id("users")),
    // Deprecated compatibility for an earlier per-setter goal draft.
    // Do not read or write this field; team goal lives on tenants.
    dailyQualificationQuota: v.optional(v.number()),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    lastSyncedAt: v.number(),
  })
    .index("by_tenantId_and_slackUserId", ["tenantId", "slackUserId"])
    .index("by_installationId_and_slackUserId", [
      "installationId",
      "slackUserId",
    ])
    .index("by_slackTeamId_and_slackUserId", [
      "slackTeamId",
      "slackUserId",
    ])
    .index("by_tenantId", ["tenantId"]),

  /**
   * Redacted audit trail of inbound Slack payloads. Raw bodies are used only
   * in memory for HMAC verification and hashing.
   */
  rawSlackEvents: defineTable({
    tenantId: v.optional(v.id("tenants")),
    teamId: v.string(),
    apiAppId: v.optional(v.string()),
    eventType: v.string(),
    payloadRedacted: v.string(),
    requestHash: v.string(),
    slackEventId: v.optional(v.string()),
    receivedAt: v.number(),
    expiresAt: v.number(),
    processed: v.boolean(),
    processingError: v.optional(v.string()),
  })
    .index("by_tenantId_and_processed", ["tenantId", "processed"])
    .index("by_teamId", ["teamId"])
    .index("by_teamId_and_apiAppId", ["teamId", "apiAppId"])
    .index("by_requestHash", ["requestHash"])
    .index("by_expiresAt", ["expiresAt"]),
  // === End Slack Bot v1 ===

  // === Public Support Requests ===
  supportTickets: defineTable({
    name: v.string(),
    email: v.string(),
    organizationName: v.optional(v.string()),
    slackWorkspace: v.optional(v.string()),
    subject: v.string(),
    message: v.string(),
    source: v.literal("support_page"),
    status: v.union(
      v.literal("new"),
      v.literal("reviewed"),
      v.literal("closed"),
    ),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_status_and_createdAt", ["status", "createdAt"]),
  // === End Public Support Requests ===
});
