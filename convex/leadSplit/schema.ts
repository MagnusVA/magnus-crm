import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import { opportunityStatusValidator } from "../opportunities/validators";
import { socialPlatformValidator } from "../lib/socialPlatform";

// Staging tables for the polluted-lead split (docs/plans/polluted-lead-split.md
// §5.1). They hold the plan and its undo log, and the invitee snapshot holds
// PII. The split's code is retired (§5.11); the rows stay as its record until
// a later PR deletes them and drops the tables.

export const leadSplitTierValidator = v.union(v.literal("A"), v.literal("B"));

export const leadSplitPlanStatusValidator = v.union(
  v.literal("draft"),
  v.literal("needs_review"),
  v.literal("approved"),
  v.literal("applying"),
  v.literal("applied"),
  v.literal("rolled_back"),
  v.literal("failed"),
  v.literal("dismissed"),
);

export const leadSplitDiscoveryReasonValidator = v.union(
  v.literal("placeholder_key"),
  v.literal("multiple_clusters"),
  v.literal("multiple_booking_emails"),
);

/** Flags that need a named reviewer. See BLOCKING_FLAGS in plan.ts. */
export const leadSplitFlagValidator = v.union(
  v.literal("snapshot_missing"),
  v.literal("snapshot_disagrees"),
  v.literal("possible_same_person"),
  v.literal("shared_email"),
  v.literal("unattributed_meeting"),
  v.literal("merge_target_ambiguous"),
  v.literal("merge_target_in_plan"),
  v.literal("outcome_review"),
  v.literal("customer_review"),
  v.literal("winning_opportunity_mismatch"),
  v.literal("followup_between_people"),
  v.literal("slack_fields_review"),
  v.literal("slack_event_mismatch"),
  v.literal("stale_override"),
  v.literal("bounds_exceeded"),
);
export type LeadSplitFlag = Infer<typeof leadSplitFlagValidator>;

/** IDs only: flag details are printed for review and must not carry PII. */
export const leadSplitFlagDetailValidator = v.object({
  flag: leadSplitFlagValidator,
  personKeys: v.optional(v.array(v.string())),
  meetingId: v.optional(v.id("meetings")),
  opportunityId: v.optional(v.id("opportunities")),
  leadIds: v.optional(v.array(v.id("leads"))),
});
export type LeadSplitFlagDetail = Infer<typeof leadSplitFlagDetailValidator>;

/**
 * Reviewer decisions, applied on every rebuild. Person keys name the
 * candidate persons (`candidateKeys` in `describe`), so they survive merges.
 */
export const leadSplitOverridesValidator = v.object({
  /** Each group of candidate persons is one person. */
  merges: v.optional(v.array(v.array(v.string()))),
  /** Each group of meetings is pulled out of its cluster as its own person. */
  separate: v.optional(v.array(v.array(v.id("meetings")))),
  /** Candidate persons left on the source lead, as part of the original. */
  skips: v.optional(v.array(v.string())),
  /**
   * The candidate person who stays on the source lead. On a lead with a
   * customer, that must be the winning meeting's person: fix a wrong winning
   * meeting with `separate` or `merges` instead.
   */
  originalPersonKey: v.optional(v.string()),
  /** Where a moved person goes: a lead their keys match, or a new lead. */
  mergeTargets: v.optional(
    v.array(v.object({ personKey: v.string(), targetLeadId: v.optional(v.id("leads")) })),
  ),
});
export type LeadSplitOverrides = Infer<typeof leadSplitOverridesValidator>;

export const leadSplitPersonRoleValidator = v.union(
  v.literal("original"),
  v.literal("new"),
  v.literal("merge_into"),
);

export const leadSplitOpportunityPlanValidator = v.object({
  opportunityId: v.id("opportunities"),
  // whole: every meeting is this person's, so the document follows them.
  // keep_document: a split opportunity whose document this person keeps (O1).
  // split_new: this person's meetings leave for a new opportunity.
  kind: v.union(
    v.literal("whole"),
    v.literal("keep_document"),
    v.literal("split_new"),
  ),
  meetingIds: v.array(v.id("meetings")),
  /** The document's status when the plan was built; apply stops if it moved. */
  statusAtBuild: opportunityStatusValidator,
  status: opportunityStatusValidator,
  /** The new opportunity takes the document's outcome fields (O1 exception). */
  inheritsOutcome: v.boolean(),
  /** Set by apply on a `split_new` entry: the opportunity it created. */
  newOpportunityId: v.optional(v.id("opportunities")),
});
export type LeadSplitOpportunityPlan = Infer<typeof leadSplitOpportunityPlanValidator>;

export const leadSplitCanonicalValidator = v.object({
  email: v.optional(v.string()),
  fullName: v.optional(v.string()),
  phone: v.optional(v.string()),
  /** The meeting whose form answers become the lead's custom fields (O5). */
  customFieldsMeetingId: v.optional(v.id("meetings")),
});

export const leadSplitSnapshotOutcomeValidator = v.union(
  v.literal("ok"),
  v.literal("not_found"),
  v.literal("http_error"),
  v.literal("network_error"),
  v.literal("invalid_uri"),
);

export const leadSplitTables = {
  leadSplitInviteeSnapshots: defineTable({
    tenantId: v.id("tenants"),
    meetingId: v.id("meetings"),
    inviteeUri: v.string(),
    outcome: leadSplitSnapshotOutcomeValidator,
    httpStatus: v.optional(v.number()),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    phone: v.optional(v.string()),
    social: v.optional(
      v.object({ platform: socialPlatformValidator, handle: v.string() }),
    ),
    fetchedAt: v.number(),
  }).index("by_meetingId", ["meetingId"]),

  leadSplitPlans: defineTable({
    tenantId: v.id("tenants"),
    sourceLeadId: v.id("leads"),
    tier: leadSplitTierValidator,
    status: leadSplitPlanStatusValidator,
    /** 0 until the first build; every build bumps it. */
    planVersion: v.number(),
    discoveryReasons: v.array(leadSplitDiscoveryReasonValidator),
    discoveredAt: v.number(),
    flags: v.array(leadSplitFlagValidator),
    flagDetails: v.array(leadSplitFlagDetailValidator),
    /** Deleted by finalize (F1). */
    placeholderIdentifierIds: v.array(v.id("leadIdentifiers")),
    unattributedMeetingIds: v.array(v.id("meetings")),
    /** Who takes the lead's Slack-entered fields (O5). */
    slackFieldsPersonKey: v.optional(v.string()),
    overrides: v.optional(leadSplitOverridesValidator),
    builtAt: v.optional(v.number()),
    approvedBy: v.optional(v.string()),
    approvedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_tenantId_and_sourceLeadId", ["tenantId", "sourceLeadId"])
    .index("by_tenantId_and_status", ["tenantId", "status"]),

  leadSplitPersons: defineTable({
    tenantId: v.id("tenants"),
    planId: v.id("leadSplitPlans"),
    planVersion: v.number(),
    personKey: v.string(),
    /** The candidate persons merged into this one; just personKey if none. */
    candidateKeys: v.array(v.string()),
    role: leadSplitPersonRoleValidator,
    /** For `new`, set by apply once the lead exists. */
    targetLeadId: v.optional(v.id("leads")),
    /** Set with merge_target_ambiguous: every lead the person's keys match. */
    mergeCandidateLeadIds: v.array(v.id("leads")),
    meetingIds: v.array(v.id("meetings")),
    identifierIds: v.array(v.id("leadIdentifiers")),
    slackEventIds: v.array(v.id("slackQualificationEvents")),
    opportunityPlan: v.array(leadSplitOpportunityPlanValidator),
    canonical: leadSplitCanonicalValidator,
    /** Apply's first pass is done: the target lead and split deals exist. */
    extractedAt: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("applied"),
      v.literal("skipped"),
    ),
  })
    .index("by_planId_and_personKey", ["planId", "personKey"])
    .index("by_planId_and_status", ["planId", "status"]),

  // Append-only undo log written by the apply migrations (§5.6, §5.9).
  leadSplitAudit: defineTable({
    tenantId: v.id("tenants"),
    planId: v.id("leadSplitPlans"),
    personKey: v.string(),
    step: v.string(),
    table: v.string(),
    docId: v.string(),
    op: v.union(v.literal("insert"), v.literal("patch"), v.literal("delete")),
    /** The full document before a patch or delete. */
    before: v.optional(v.any()),
    /** The patched fields, with cleared fields as null. */
    after: v.optional(v.any()),
    createdAt: v.number(),
    /** Set when rollback has undone the row. */
    revertedAt: v.optional(v.number()),
  })
    .index("by_planId_and_personKey_and_step", ["planId", "personKey", "step"])
    // Rollback walks a plan's rows newest first, across persons.
    .index("by_planId_and_revertedAt", ["planId", "revertedAt"]),

  // Undo log of the Tier D placeholder cleanup (§3.5): one row per identifier
  // it deleted and per lead it patched, written in the same transaction.
  leadPlaceholderCleanups: defineTable({
    tenantId: v.id("tenants"),
    leadId: v.id("leads"),
    table: v.union(v.literal("leadIdentifiers"), v.literal("leads")),
    docId: v.string(),
    op: v.union(v.literal("delete"), v.literal("patch")),
    /** The document before, without system fields. */
    before: v.any(),
    /** The patched fields, with cleared fields as null. */
    after: v.optional(v.any()),
    approvedBy: v.string(),
    createdAt: v.number(),
    /** Set when the cleanup of this lead has been undone. */
    revertedAt: v.optional(v.number()),
  }).index("by_leadId_and_revertedAt", ["leadId", "revertedAt"]),
};
