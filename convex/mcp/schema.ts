import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Tables for the AI assistant's MCP endpoint (docs/plans/closer-assistant.md
 * §4.1 and §6). The gateway component keeps its own sessions, tool registry
 * and audit log; these hold what Magnus itself writes for agents.
 */
export const financingProviderValidator = v.union(
  v.literal("clarity_pay"),
  v.literal("splitit"),
  v.literal("other"),
);

export const mcpTables = {
  // One structured note an agent writes on a deal after a call. Append-only:
  // nothing edits or deletes a note, and a wrong note gets a correcting one.
  // No leadId: the person comes from the deal, so a merge needs nothing here.
  callNotes: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    authorUserId: v.id("users"),
    meetingId: v.optional(v.id("meetings")),
    followUpId: v.optional(v.id("followUps")),
    recordingId: v.optional(v.id("callRecordings")),
    // Each at most 1,000 characters, enforced by the write path.
    currentSituation: v.string(),
    goal: v.string(),
    bottleneck: v.string(),
    objection: v.string(),
    nextAction: v.optional(v.string()),
    financingProvider: v.optional(financingProviderValidator),
    // clientInfo.name the MCP client sent on initialize.
    agentClient: v.string(),
    // SHA-256 of the note's fields, so a retried call returns the first note.
    contentHash: v.string(),
    createdAt: v.number(),
  })
    .index("by_tenantId_and_opportunityId_and_createdAt", [
      "tenantId",
      "opportunityId",
      "createdAt",
    ])
    .index("by_tenantId_and_authorUserId_and_createdAt", [
      "tenantId",
      "authorUserId",
      "createdAt",
    ])
    .index("by_meetingId", ["meetingId"])
    .index("by_authorUserId_and_contentHash", ["authorUserId", "contentHash"]),

  // A proof file an agent brought, before it backs a payment.
  paymentProofUploads: defineTable({
    tenantId: v.id("tenants"),
    userId: v.id("users"),
    source: v.union(v.literal("upload_url"), v.literal("chatgpt_file")),
    // upload_url only: SHA-256 of the single-use ticket, and its expiry.
    ticketHash: v.optional(v.string()),
    ticketExpiresAt: v.optional(v.number()),
    storageId: v.optional(v.id("_storage")),
    fileName: v.optional(v.string()),
    contentType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    sha256: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("attached"),
      v.literal("expired"),
    ),
    paymentId: v.optional(v.id("paymentRecords")),
    createdAt: v.number(),
  })
    .index("by_ticketHash", ["ticketHash"])
    .index("by_tenantId_and_userId_and_status", ["tenantId", "userId", "status"]),

  // Preview-then-commit tokens for writes that last (decision 17). A preview
  // stores the arguments' hash; a commit must present the token and the same
  // arguments within 10 minutes. A used token keeps the result, so a retried
  // commit returns what the first one did.
  mcpConfirmations: defineTable({
    tenantId: v.id("tenants"),
    userId: v.id("users"),
    tool: v.string(),
    tokenHash: v.string(),
    argsHash: v.string(),
    preview: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    // JSON of the commit's result, returned again on a retry.
    resultJson: v.optional(v.string()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_expiresAt", ["expiresAt"]),

  // The client name each MCP session started with. The gateway doesn't pass
  // clientInfo to tools, so the HTTP mount records it on initialize and
  // forwards it in the caller's claims.
  mcpClientSessions: defineTable({
    sessionId: v.string(),
    clientName: v.string(),
    clientVersion: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_createdAt", ["createdAt"]),
};
