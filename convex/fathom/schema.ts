import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Fathom recordings in Magnus (docs/plans/closer-assistant.md §4.1, §6.5). */
export const fathomTables = {
  // One row per tenant, like tenantCalendlyConnections. Only internal
  // functions read the key and the webhook secret; the browser sees keyLast4.
  tenantFathomConnections: defineTable({
    tenantId: v.id("tenants"),
    apiKey: v.string(),
    keyLast4: v.string(),
    keyHolderEmail: v.optional(v.string()),
    keyHolderIsAccountAdmin: v.optional(v.boolean()),
    webhookId: v.optional(v.string()),
    webhookSecret: v.optional(v.string()),
    triggeredFor: v.array(v.string()),
    connectionStatus: v.union(
      v.literal("connected"),
      v.literal("invalid_key"),
      v.literal("disconnected"),
    ),
    lastWebhookAt: v.optional(v.number()),
    lastReconciledAt: v.optional(v.number()),
    lastMemberSyncAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    connectedByUserId: v.id("users"),
    connectedAt: v.number(),
    // Additive operational state. No existing row needs a backfill.
    operationToken: v.optional(v.string()),
    operationUntil: v.optional(v.number()),
    nextRequestAt: v.optional(v.number()),
    reconcileToken: v.optional(v.string()),
    reconcileUntil: v.optional(v.number()),
    droppedCount: v.optional(v.number()),
    healthWarnings: v.optional(v.array(v.string())),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_connectionStatus", ["connectionStatus"]),

  // Fathom's roster, like calendlyOrgMembers. Not a staff table: it mirrors a
  // vendor roster, links each member to a user, and holds no role.
  fathomOrgMembers: defineTable({
    tenantId: v.id("tenants"),
    email: v.string(),
    name: v.optional(v.string()),
    fathomTeam: v.optional(v.string()),
    // Only when the key holder is an account admin.
    viewAccessLevel: v.optional(v.string()),
    settingsAccessLevel: v.optional(v.string()),
    matchedUserId: v.optional(v.id("users")),
    ignored: v.boolean(),
    lastSyncedAt: v.number(),
  })
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_matchedUserId", ["tenantId", "matchedUserId"]),

  // Raw deliveries, kept until processed and purged after 7 days.
  fathomWebhookEvents: defineTable({
    tenantId: v.id("tenants"),
    connectionId: v.id("tenantFathomConnections"),
    webhookMessageId: v.string(),
    receivedAt: v.number(),
    payload: v.string(),
    payloadStorageId: v.optional(v.id("_storage")),
    attempts: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("processed"),
      v.literal("dropped"),
      v.literal("held"),
      v.literal("failed"),
    ),
    holdUntil: v.optional(v.number()),
    processedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    // The trace a dropped internal-only recording leaves, so a no-show check
    // can tell the closer made another recording around the meeting. No
    // content; purged with the row after 7 days.
    droppedRecordedByEmail: v.optional(v.string()),
    droppedRecordingStartAt: v.optional(v.number()),
    droppedRecordingEndAt: v.optional(v.number()),
  })
    .index("by_tenantId_and_webhookMessageId", ["tenantId", "webhookMessageId"])
    .index("by_status_and_holdUntil", ["status", "holdUntil"])
    .index("by_status_and_receivedAt", ["status", "receivedAt"])
    .index("by_tenantId_and_status_and_receivedAt", [
      "tenantId",
      "status",
      "receivedAt",
    ]),

  // One Fathom recording. It keeps only its meeting: the deal and the person
  // come from the meeting, so a merge or a deal move needs nothing here.
  callRecordings: defineTable({
    tenantId: v.id("tenants"),
    connectionId: v.id("tenantFathomConnections"),
    recordedByUserId: v.optional(v.id("users")),
    recordedByEmail: v.string(),
    meetingId: v.optional(v.id("meetings")),
    fathomRecordingId: v.number(),
    url: v.string(),
    shareUrl: v.string(),
    title: v.string(),
    meetingTitle: v.optional(v.string()),
    scheduledStartAt: v.optional(v.number()),
    scheduledEndAt: v.optional(v.number()),
    recordingStartAt: v.number(),
    recordingEndAt: v.number(),
    transcriptExpiresAt: v.optional(v.number()),
    summaryMarkdown: v.optional(v.string()),
    actionItems: v.optional(
      v.array(
        v.object({
          description: v.string(),
          assigneeEmail: v.optional(v.string()),
          timestamp: v.optional(v.string()),
        }),
      ),
    ),
    // The transcript lives in file storage: a document caps at 1 MiB.
    transcriptStorageId: v.optional(v.id("_storage")),
    transcriptLanguage: v.optional(v.string()),
    transcriptLineCount: v.optional(v.number()),
    transcriptDeletedAt: v.optional(v.number()),
    // Fathom's invitee list, for matching and reassignment only. Not a copy
    // of the person's identifiers, and nothing reads it as identity.
    inviteeEmails: v.array(v.string()),
    matchStatus: v.union(
      v.literal("matched"),
      v.literal("unmatched"),
      v.literal("ignored"),
    ),
    matchMethod: v.optional(
      v.union(
        v.literal("time_email"),
        v.literal("time_url"),
        v.literal("time_only"),
        v.literal("manual"),
      ),
    ),
    rawEventId: v.optional(v.id("fathomWebhookEvents")),
    createdAt: v.number(),
    matchedAt: v.optional(v.number()),
    matchedByUserId: v.optional(v.id("users")),
  })
    .index("by_tenantId_and_recordedByUserId_and_matchStatus", [
      "tenantId",
      "recordedByUserId",
      "matchStatus",
    ])
    .index("by_tenantId_and_matchStatus_and_createdAt", [
      "tenantId",
      "matchStatus",
      "createdAt",
    ])
    .index("by_meetingId", ["meetingId"])
    .index("by_tenantId_and_fathomRecordingId", [
      "tenantId",
      "fathomRecordingId",
    ])
    .index("by_transcriptExpiresAt", ["transcriptExpiresAt"])
    .index("by_transcriptDeletedAt_and_createdAt", [
      "transcriptDeletedAt",
      "createdAt",
    ]),
};
