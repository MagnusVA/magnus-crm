import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  artifactStateValidator,
  normalizedReportRangeValidator,
  reportFailureValidator,
  reportFormatValidator,
  reportKindValidator,
  reportPhaseValidator,
  reportPurposeValidator,
  reportSourceFilterValidator,
  reportStatusValidator,
  scalarRecordValidator,
} from "./contracts";

export const operationsReportTables = {
  operationsReportAdmission: defineTable({
    tenantId: v.id("tenants"),
    slots: v.array(v.object({ jobId: v.id("operationsReportJobs"), userId: v.id("users"), purpose: reportPurposeValidator, requestKey: v.string() })),
  }).index("by_tenantId", ["tenantId"]),
  operationsReportJobs: defineTable({
    tenantId: v.id("tenants"),
    requestedByUserId: v.id("users"),
    executionVersion: v.optional(v.literal(2)),
    purpose: reportPurposeValidator,
    reportKind: reportKindValidator,
    format: v.optional(reportFormatValidator),
    range: normalizedReportRangeValidator,
    sourceFilter: reportSourceFilterValidator,
    requestToken: v.string(),
    requestKey: v.string(),
    definitionVersion: v.string(),
    status: reportStatusValidator,
    phase: reportPhaseValidator,
    rowsProcessed: v.number(),
    pagesProcessed: v.number(),
    artifactCount: v.number(),
    checkpointSequence: v.number(),
    leaseGeneration: v.number(),
    leaseOwner: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    retryCount: v.number(),
    scheduledFunctionId: v.optional(v.id("_scheduled_functions")),
    failure: v.optional(reportFailureValidator),
    queuedAt: v.number(),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    canceledAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    purgeAt: v.optional(v.number()),
    cleanupPending: v.boolean(),
    cleanupNextAttemptAt: v.optional(v.number()),
    cleanupStartedAt: v.optional(v.number()),
    cleanupCompletedAt: v.optional(v.number()),
  })
    .index("by_tenantId_and_requestedByUserId_and_requestToken", [
      "tenantId",
      "requestedByUserId",
      "requestToken",
    ])
    .index("by_tenantId_and_requestedByUserId_and_requestKey_and_status", [
      "tenantId",
      "requestedByUserId",
      "requestKey",
      "status",
    ])
    .index("by_tenantId_and_requestedByUserId_and_purpose_and_status", [
      "tenantId",
      "requestedByUserId",
      "purpose",
      "status",
    ])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    .index("by_status_and_leaseExpiresAt", ["status", "leaseExpiresAt"])
    .index("by_status_and_expiresAt", ["status", "expiresAt"])
    .index("by_status_and_queuedAt", ["status", "queuedAt"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_cleanupPending_and_expiresAt", ["cleanupPending", "expiresAt"])
    .index("by_cleanupPending_and_cleanupNextAttemptAt", [
      "cleanupPending",
      "cleanupNextAttemptAt",
    ])
    .index("by_cleanupPending_and_purgeAt", ["cleanupPending", "purgeAt"])
    .index("by_purgeAt", ["purgeAt"]),

  operationsReportCheckpoints: defineTable({
    tenantId: v.id("tenants"),
    jobId: v.id("operationsReportJobs"),
    sourceKey: v.string(),
    cursor: v.optional(v.string()),
    splitCursor: v.optional(v.string()),
    sequence: v.number(),
    completed: v.boolean(),
    rowsProcessed: v.number(),
    renderPosition: v.optional(v.number()),
    lastCommitKey: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_jobId_and_sourceKey", ["jobId", "sourceKey"])
    .index("by_jobId", ["jobId"]),

  operationsReportRows: defineTable({
    tenantId: v.id("tenants"),
    jobId: v.id("operationsReportJobs"),
    rowType: v.union(
      v.literal("staging"),
      v.literal("result"),
      v.literal("dedupe"),
    ),
    section: v.string(),
    rowKey: v.string(),
    groupKey: v.optional(v.string()),
    payload: scalarRecordValidator,
    sortValue: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_jobId_and_section_and_rowKey", [
      "jobId",
      "section",
      "rowKey",
    ])
    .index("by_jobId_and_section_and_sortValue", [
      "jobId",
      "section",
      "sortValue",
    ])
    .index("by_jobId_and_section_and_rowType_and_rowKey", [
      "jobId",
      "section",
      "rowType",
      "rowKey",
    ])
    .index("by_jobId_and_section_and_rowType_and_sortValue", [
      "jobId",
      "section",
      "rowType",
      "sortValue",
    ])
    .index("by_jobId_and_section_and_groupKey_and_sortValue", [
      "jobId",
      "section",
      "groupKey",
      "sortValue",
    ])
    .index("by_jobId_and_rowType", ["jobId", "rowType"])
    .index("by_jobId", ["jobId"]),

  operationsReportArtifacts: defineTable({
    tenantId: v.id("tenants"),
    jobId: v.id("operationsReportJobs"),
    partNumber: v.number(),
    filename: v.string(),
    mimeType: v.string(),
    ownershipContentType: v.string(),
    state: artifactStateValidator,
    storageId: v.optional(v.id("_storage")),
    expectedSha256: v.string(),
    expectedByteSize: v.number(),
    byteSize: v.optional(v.number()),
    rowCount: v.number(),
    ownershipToken: v.string(),
    reservedAt: v.number(),
    reservationExpiresAt: v.number(),
    attachedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    reconciliationCursor: v.optional(v.string()),
    reconciliationComplete: v.boolean(),
    deleteAttempts: v.number(),
    lastDeleteError: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_jobId_and_partNumber", ["jobId", "partNumber"])
    .index("by_job_state_reconciliation_reservation", [
      "jobId",
      "state",
      "reconciliationComplete",
      "reservationExpiresAt",
    ])
    .index("by_ownershipToken", ["ownershipToken"])
    .index("by_state_and_reservationExpiresAt", [
      "state",
      "reservationExpiresAt",
    ])
    .index("by_reconciliationComplete_and_reservationExpiresAt", [
      "reconciliationComplete",
      "reservationExpiresAt",
    ])
    .index("by_expiresAt", ["expiresAt"]),
};
