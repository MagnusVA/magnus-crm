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
    resultJson: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    // Answers expire with the next warehouse sync; rows are pruned after this.
    expiresAt: v.number(),
  })
    .index("by_tenantId_and_key", ["tenantId", "key"])
    .index("by_status_and_createdAt", ["status", "createdAt"])
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"]),
};
