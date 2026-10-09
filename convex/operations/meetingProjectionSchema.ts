import { defineTable } from "convex/server";
import { v } from "convex/values";
import { opportunityStatusValidator } from "../opportunities/validators";

export const meetingContribution = v.object({
  dayKey: v.string(),
  assignedCloserId: v.id("users"),
  bookingProgramId: v.optional(v.id("tenantPrograms")),
  soldProgramId: v.optional(v.id("tenantPrograms")),
  attributionTeamId: v.optional(v.id("attributionTeams")),
  dmCloserId: v.optional(v.id("dmClosers")),
  opportunityStatus: v.optional(opportunityStatusValidator),
  meetingStatus: v.union(
    v.literal("scheduled"),
    v.literal("completed"),
    v.literal("canceled"),
    v.literal("no_show"),
  ),
});
export const meetingProjectionTables = {
  opportunityProjectionJobs: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    generation: v.number(),
    status: v.union(
      v.literal("queued"),
      v.literal("applied"),
      v.literal("failed"),
    ),
    cursor: v.union(v.string(), v.null()),
    dirty: v.boolean(),
    requestedAt: v.number(),
    reason: v.optional(v.string()),
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_status_and_requestedAt", ["status", "requestedAt"])
    .index("by_tenantId_and_status_and_requestedAt", [
      "tenantId",
      "status",
      "requestedAt",
    ]),
  // A fresh table avoids seeding new contributions from the known-corrupt rollup.
  operationsMeetingStatsV2: defineTable({
    tenantId: v.id("tenants"),
    ...meetingContribution.fields,
    bucketKey: v.string(),
    count: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenantId_and_bucketKey", ["tenantId", "bucketKey"])
    .index("by_tenantId_and_dayKey", ["tenantId", "dayKey"])
    .index("by_tenantId_and_assignedCloserId_and_dayKey", [
      "tenantId",
      "assignedCloserId",
      "dayKey",
    ]),
  meetingProjections: defineTable({
    tenantId: v.id("tenants"),
    meetingId: v.id("meetings"),
    generation: v.number(),
    status: v.union(
      v.literal("queued"),
      v.literal("applied"),
      v.literal("failed"),
    ),
    requestedAt: v.number(),
    appliedAt: v.optional(v.number()),
    reason: v.optional(v.string()),
    contribution: v.optional(meetingContribution),
    bucketKey: v.optional(v.string()),
  })
    .index("by_meetingId", ["meetingId"])
    .index("by_tenantId_and_bucketKey", ["tenantId", "bucketKey"])
    .index("by_status_and_requestedAt", ["status", "requestedAt"])
    .index("by_tenantId_and_status_and_requestedAt", [
      "tenantId",
      "status",
      "requestedAt",
    ]),
};
