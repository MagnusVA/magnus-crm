import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Report answers the admin assistant asked for (docs/plans/admin-assistant.md §3).
 * Kept apart from `analyticsResults` on purpose: the post-sync refresh reads
 * that table, and an assistant's keys must never take a web report's slot or
 * spend the pages' daily run budget.
 */
export const mcpReportTables = {
  mcpReportRequests: defineTable({
    tenantId: v.id("tenants"),
    userId: v.id("users"),
    // Stable key of the report, its filters and its window.
    key: v.string(),
    report: v.string(),
    paramsJson: v.string(),
    status: v.union(
      v.literal("waiting"),
      v.literal("running"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    // Optional additions: widen only, no backfill or narrowing required.
    kind: v.optional(v.union(v.literal("job"), v.literal("allowance"))),
    watermark: v.optional(v.number()),
    runToken: v.optional(v.string()),
    workId: v.optional(v.string()),
    runCount: v.optional(v.number()),
    minuteStartedAt: v.optional(v.number()),
    minuteCount: v.optional(v.number()),
    // Inline answers written before answers moved to mcpReportPayloads.
    resultJson: v.optional(v.string()),
    // A ready answer stored in parts: how many, under which run.
    payloadParts: v.optional(v.number()),
    payloadRunToken: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    executingAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    // Answers expire with the next warehouse sync; rows are pruned after this.
    expiresAt: v.number(),
  })
    .index("by_tenantId_and_key", ["tenantId", "key"])
    .index("by_status_and_createdAt", ["status", "createdAt"])
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_tenantId_and_expiresAt", ["tenantId", "expiresAt"]),
  // One answer in parts of up to 900 KB, so an answer can outgrow a 1 MiB
  // document (People's lead gen panel is about 5 MB for a year). Parts belong
  // to one run of one request; a part of another run is never read.
  mcpReportPayloads: defineTable({
    tenantId: v.id("tenants"),
    requestId: v.id("mcpReportRequests"),
    runToken: v.string(),
    index: v.number(),
    json: v.string(),
  }).index("by_requestId_and_runToken_and_index", [
    "requestId",
    "runToken",
    "index",
  ]),
};
