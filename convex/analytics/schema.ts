import { defineTable } from "convex/server";
import { v } from "convex/values";

// Reporting from ClickHouse (docs/plans/clickhouse-reporting.md §8).

export const analyticsRangeValidator = v.union(
  v.object({
    kind: v.literal("preset"),
    preset: v.union(
      v.literal("yesterday"),
      v.literal("this_week"),
      v.literal("this_month"),
      v.literal("last_month"),
      v.literal("last_90_days"),
    ),
  }),
  v.object({
    kind: v.literal("custom"),
    startDate: v.string(),
    endDateInclusive: v.string(),
  }),
);

/**
 * The report pages that can read ClickHouse. `tenants.analyticsReports` lists
 * the ones switched on for a tenant (§12.1).
 */
export const analyticsPageValidator = v.union(
  v.literal("revenue"),
  v.literal("team"),
  v.literal("pipeline"),
  v.literal("leads"),
  v.literal("activity"),
  v.literal("reminders"),
  v.literal("slack_qualifications"),
  v.literal("sales_calls"),
  v.literal("booked_calls"),
  v.literal("qualifications"),
  v.literal("lead_gen"),
  v.literal("overview"),
  v.literal("my_activity"),
);

export const apiKeyScopeValidator = v.literal("metrics:read");

export const analyticsTables = {
  /**
   * One shared answer per report key: the newest good payload and the state of
   * the latest run. Pages subscribe to it; the post-sync batch refreshes it.
   */
  analyticsResults: defineTable({
    tenantId: v.id("tenants"),
    reportId: v.string(),
    // Canonical JSON of filters, range and day; never millisecond bounds.
    argsKey: v.string(),
    filtersJson: v.string(),
    range: analyticsRangeValidator,
    timeZone: v.string(),
    dayStartHour: v.number(),
    status: v.union(
      v.literal("queued"),
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    // The newest good answer. Kept in its own table so the budget, the batch
    // and cleanup read small rows.
    payloadId: v.optional(v.id("analyticsPayloads")),
    answer: v.optional(
      v.object({
        watermark: v.number(),
        startDate: v.string(),
        endDateInclusive: v.string(),
        completedAt: v.number(),
      }),
    ),
    run: v.optional(
      v.object({
        id: v.string(),
        watermark: v.number(),
        // Queued: on the pool for a page or API run, or started by the batch.
        startedAt: v.number(),
        // The action began; unset while the run waits on the pool.
        executingAt: v.optional(v.number()),
      }),
    ),
    errorMessage: v.optional(v.string()),
    failedAt: v.optional(v.number()),
    // Runs a page or API request started, not the batch: the latest, and how
    // many since `missWindowStart`. They count against the daily budget.
    missedAt: v.optional(v.number()),
    missWindowStart: v.optional(v.number()),
    missCount: v.optional(v.number()),
    lastRequestedAt: v.number(),
  })
    .index("by_tenantId_and_reportId_and_argsKey", [
      "tenantId",
      "reportId",
      "argsKey",
    ])
    .index("by_lastRequestedAt", ["lastRequestedAt"])
    .index("by_tenantId_and_missedAt", ["tenantId", "missedAt"]),

  /** An answer's JSON, under 900 KB, owned by one `analyticsResults` row. */
  analyticsPayloads: defineTable({
    tenantId: v.id("tenants"),
    json: v.string(),
  }),

  /**
   * One row. The 5-minute heartbeat patches `beatAt`, and Fivetran copies it,
   * so ClickHouse's copy is the newest write a sync included (§8.2). No page
   * or query reads this table.
   */
  analyticsSync: defineTable({
    beatAt: v.number(),
    watermark: v.optional(v.number()),
    lastSyncEndedAt: v.optional(v.number()),
    lastSyncId: v.optional(v.string()),
    lastSyncStatus: v.optional(v.string()),
    lastBatchStartedAt: v.optional(v.number()),
    lastBatchAt: v.optional(v.number()),
    staleReportedAt: v.optional(v.number()),
  }),

  /** Keys for outside callers of `/api/v1` (§9). The secret is never stored. */
  apiKeys: defineTable({
    tenantId: v.id("tenants"),
    keyId: v.string(),
    // Hex SHA-256 of the random secret.
    secretHash: v.string(),
    name: v.string(),
    scopes: v.array(apiKeyScopeValidator),
    createdByUserId: v.id("users"),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    revokedByUserId: v.optional(v.id("users")),
    // 60 requests a minute, counted on the key's own row.
    rateWindowStartedAt: v.optional(v.number()),
    rateWindowCount: v.optional(v.number()),
  })
    .index("by_keyId", ["keyId"])
    .index("by_tenantId", ["tenantId"]),
};
