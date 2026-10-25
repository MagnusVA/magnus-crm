import { v } from "convex/values";

export const attributionResolutionValidator = v.union(
  v.literal("mapped"),
  v.literal("unmapped"),
  v.literal("internal"),
  v.literal("none"),
);

export const bookingProgramMappingStatusValidator = v.union(
  v.literal("mapped"),
  v.literal("unmapped"),
);

// docs/plans/phase-3-attribution.md §3.1. The job a team member (or, for
// dm_team, a team) did on a deal.
export const dealAttributionRoleValidator = v.union(
  v.literal("lead_gen"),
  v.literal("setter"),
  v.literal("dm_team"),
  v.literal("dm_closer"),
  v.literal("closer"),
);

// Where each row's fact came from. Lead gen credit distinguishes capture
// from the respark that started a later buying attempt.
export const dealAttributionSourceValidator = v.union(
  // lead gen: the capture that was the person's first touch
  v.object({
    kind: v.literal("capture"),
    prospectId: v.id("leadGenProspects"),
    workerId: v.id("leadGenWorkers"),
    eventId: v.id("domainEvents"),
  }),
  // lead gen: the respark that started this buying attempt
  v.object({
    kind: v.literal("respark"),
    itemId: v.id("resparkBatchItems"),
    workerId: v.id("leadGenWorkers"),
    eventId: v.id("domainEvents"),
  }),
  // setter: a qualification event, or `qualifiedBy` on deals older than the events
  v.object({
    kind: v.literal("slack_qualification"),
    slackUserId: v.string(),
    qualificationEventId: v.optional(v.id("slackQualificationEvents")),
  }),
  // DM team and DM closer: the booking's UTMs
  v.object({
    kind: v.literal("booking_utm"),
    dmCloserId: v.optional(v.id("dmClosers")),
  }),
  // closer: the closer the booking was assigned to (the Calendly host)
  v.object({ kind: v.literal("booking_closer"), userId: v.id("users") }),
  // closer: a reassignment of a meeting or of the deal
  v.object({
    kind: v.literal("reassignment"),
    userId: v.id("users"),
    fromUserId: v.optional(v.id("users")),
  }),
  // closer: whoever a side deal names
  v.object({ kind: v.literal("side_deal"), userId: v.id("users") }),
);
