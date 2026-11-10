import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A lead generator's end-of-shift report (docs/plans/lead-gen-assistant.md,
 * "Release 2"). One per worker per business day, never edited: Magnus counts
 * the numbers at the commit, and only the Slack delivery fields change after.
 * Lead gen rows never go into `endOfDayReports`, which is the closer's.
 */
export const leadGenShiftNumbersValidator = v.object({
  rawLeads: v.number(),
  resparks: v.number(),
  entries: v.number(),
  notAFit: v.number(),
  // Null when the schedule read was incomplete: unknown, never zero.
  scheduledHours: v.union(v.number(), v.null()),
  leadsPerHour: v.union(v.number(), v.null()),
});

export const leadGenShiftTables = {
  leadGenShiftReports: defineTable({
    tenantId: v.id("tenants"),
    userId: v.id("users"),
    workerId: v.id("leadGenWorkers"),
    dayKey: v.string(),
    periodStart: v.number(),
    periodEnd: v.number(),
    asOf: v.number(),
    timeZone: v.string(),
    dayStartHour: v.number(),
    businessDayVersion: v.number(),
    numbers: leadGenShiftNumbersValidator,
    hoursStatus: v.union(v.literal("known"), v.literal("unknown")),
    hoursUnknownReason: v.optional(
      v.union(v.literal("row_limit"), v.literal("byte_limit"), v.literal("incomplete")),
    ),
    narrative: v.optional(v.string()),
    note: v.optional(v.string()),
    via: v.union(v.literal("web"), v.literal("mcp")),
    agentClient: v.optional(v.string()),
    createdAt: v.number(),
    slackStatus: v.union(
      v.literal("pending"),
      v.literal("posted"),
      v.literal("not_configured"),
      v.literal("failed"),
    ),
    slackChannelId: v.optional(v.string()),
    slackChannelName: v.optional(v.string()),
    slackTs: v.optional(v.string()),
    slackError: v.optional(v.string()),
    slackPostStartedAt: v.optional(v.number()),
    slackPostAttempt: v.optional(v.string()),
    postedAt: v.optional(v.number()),
  }).index("by_tenantId_and_workerId_and_dayKey", ["tenantId", "workerId", "dayKey"]),
};
